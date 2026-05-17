# Subprocess patterns

Quatre patterns de driver pour orchestrer un subprocess depuis le daemon Hono :

1. **`claude-cli`** : spawn `claude -p --output-format stream-json` (le pattern par défaut du template).
2. **`maestro`** : spawn `~/.maestro/bin/maestro test <yaml>` + lecture des logs.
3. **`http-api`** : fetch en boucle vers une API HTTP locale, avec timeout long.
4. **`cli-custom`** : spawn arbitraire + parser custom du stdout.

Chaque section décrit la signature suggérée du driver, où placer les events
SSE, et les pièges à dédupliquer.

---

## 1. claude-cli

**C'est ce que fait le template par défaut** (`server/runs.ts`).

### Signature

```ts
// server/runs.ts
interface StartRunOptions extends BuildArgsOptions {
  prompt: string;
  cwd: string;
  tag?: string;
}
export function startRun(opts: StartRunOptions): RunRecord;
```

### Spawn

```ts
const child = spawn("claude", buildClaudeArgs(opts), {
  cwd: opts.cwd,
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
  env: {
    ...process.env,
    CLAUDE_CODE_DISABLE_THINKING: "1",
    CI: "1",
    NO_COLOR: "1",
  },
});
child.stdin.write(opts.prompt, "utf8");
child.stdin.end();
```

### Parser

`server/parse-stream.ts::StreamParser`. Pipe `child.stdout` (UTF-8, ligne par
ligne JSON) → émet des `AgentEvent` typés. Le parser gère les usage events
(extraction depuis `message_start` et `assistant`), le streaming de
`text_delta` / `thinking_delta`, les `tool_use_start/end`, et les `result`.

### Dédup

Les events `usage` arrivent 2x par tour (`message_start` puis `assistant`)
avec le même `message_id`. Dédup côté broadcast (cf. `server/runs.ts::broadcast`).

### SSE

`attachListener(runId, fn)` retourne un handle ; les events sont accumulés
dans `run.events` et fan-out vers tous les listeners. Le route SSE
`GET /api/runs/:id/events` rejoue d'abord les events accumulés puis streame.

---

## 2. maestro

Pour piloter un émulateur Android (ou iOS) via Maestro 2.5+.

### Signature suggérée

```ts
// server/maestro-driver.ts
export interface MaestroRunOptions {
  flowTemplatePath: string;     // chemin du YAML template
  variables: Record<string, string>; // valeurs à injecter (templating direct)
  timeoutMs: number;
}

export interface MaestroEvent {
  kind: "stdout" | "stderr" | "step-start" | "step-end" | "screenshot" | "end";
  text?: string;
  stepIndex?: number;
  screenshotPath?: string;
  exitCode?: number | null;
  ts: number;
}

export function runMaestroFlow(opts: MaestroRunOptions): {
  id: string;
  events: AsyncIterable<MaestroEvent>;
  cancel: () => void;
};
```

### Templating

`--env` de Maestro 2.5.1 n'override pas les defaults YAML (cf. gotchas.md).
**Toujours** templater le YAML directement :

```ts
const raw = fs.readFileSync(flowTemplatePath, "utf8");
let resolved = raw;
for (const [k, v] of Object.entries(opts.variables)) {
  const safe = stripAccents(v); // inputText ne supporte pas Unicode (cf. gotchas)
  resolved = resolved.replace(new RegExp(`__${k.toUpperCase()}__`, "g"), safe);
}
const tmpYaml = path.join(os.tmpdir(), `maestro-${randomUUID()}.yaml`);
fs.writeFileSync(tmpYaml, resolved);
```

### Spawn

```ts
const child = spawn(
  process.env.MAESTRO_BIN ?? path.join(os.homedir(), ".maestro/bin/maestro"),
  ["test", tmpYaml, "--no-ansi", "--format", "junit"],
  { stdio: ["ignore", "pipe", "pipe"], shell: false }
);
```

### Parser

Maestro écrit ses logs détaillés dans `~/.maestro/tests/<runId>/maestro.log`.
Le stdout du process ne contient que un résumé. Pour extraire les timings
fins (`t_send`, `t_reply`), parser `maestro.log` *après* la fin du run :

```ts
function parseMaestroLog(runDir: string): { steps: Step[]; screenshotsDir: string } {
  const log = fs.readFileSync(path.join(runDir, "maestro.log"), "utf8");
  const steps: Step[] = [];
  for (const line of log.split("\n")) {
    const m = line.match(/\[(\d{2}:\d{2}:\d{2}\.\d{3})\] (.*)/);
    if (m) steps.push({ ts: m[1], msg: m[2] });
  }
  return { steps, screenshotsDir: path.join(runDir, "screenshots") };
}
```

### SSE

Ton runner émet des `MaestroEvent` via un `EventEmitter`. Crée une route
dédiée `GET /api/<entities>/:id/events` qui consomme cet émitteur et le fan-out
en SSE (similaire à `server/runs.ts::attachListener`).

---

## 3. http-api

Pour appeler un LLM local (mlx-lm, llama.cpp server, vLLM, …) ou n'importe
quelle API HTTP qui prend du temps à répondre.

### Signature suggérée

```ts
// server/api-driver.ts
export interface ApiCallOptions {
  url: string;
  body: unknown;
  timeoutMs?: number;  // défaut 180_000
  headers?: Record<string, string>;
}

export async function callApi<T>(opts: ApiCallOptions): Promise<T>;
```

### Implémentation

```ts
export async function callApi<T>(opts: ApiCallOptions): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 180_000);
  try {
    const r = await fetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(opts.body),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}
```

### Pourquoi explicite

Le `headersTimeout` par défaut de l'undici embarqué dans Node est **5min**
(cf. gotchas.md). Pour un LLM qui peut prendre 3-5min sur un long prompt,
toujours passer un `AbortSignal` explicite. Le `timeout` au niveau headers
ne suffit pas.

### SSE pour les longues opérations

Si tu veux streamer la progression vers l'UI sans attendre la fin, le serveur
HTTP qui te répond doit lui-même streamer (SSE / chunked / NDJSON).
mlx-lm.server supporte `"stream": true` ; tu lis le response body en chunks :

```ts
const r = await fetch(url, { method: "POST", body: JSON.stringify({ ...payload, stream: true }) });
const reader = r.body!.getReader();
const dec = new TextDecoder();
let buffer = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += dec.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.startsWith("data: ")) emitDelta(line.slice(6));
  }
}
```

---

## 4. cli-custom

Pour un CLI arbitraire (autre outil de test, linter, builder, …) dont tu
définis toi-même le format de stdout.

### Signature

Identique au pattern claude-cli mais avec ton propre parser :

```ts
// server/<tool>-driver.ts
export interface ToolRunOptions {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface ToolEvent {
  kind: "stdout" | "stderr" | "result" | "error";
  text?: string;
  exitCode?: number | null;
  ts: number;
}

export function runTool(opts: ToolRunOptions): {
  id: string;
  events: AsyncIterable<ToolEvent>;
  cancel: () => void;
};
```

### Parser

Si ton CLI produit du JSON ligne par ligne (NDJSON), réutilise le pattern
de `StreamParser` : buffer + split sur `\n` + JSON.parse + dispatch sur un
champ `type`. Sinon, parser ad-hoc selon le format.

### Quand utiliser cli-custom plutôt que claude-cli

- Quand tu ne veux pas la verbosité du stream-json claude.
- Quand tu pilotes un outil qui n'a pas d'équivalent stream-json (rsync,
  ffmpeg, …).
- Quand tu veux remplacer le subprocess principal par un fake testable.

### Quand utiliser tous ces patterns en même temps

Une app calibrage typique (cf. `marcelle-calibre` du plan) combine **maestro**
(pour piloter l'émulateur) + **http-api** (pour taper l'API que l'émulateur
consomme aussi en parallèle) + **claude-cli** (pour la phase "scoring +
hallucination detection" off-line). C'est OK ; chaque driver vit dans son
propre fichier et le runner global les compose.
