/**
 * Bundle de diagnostic à envoyer au support.
 *
 * Génère un ZIP en mémoire avec les éléments utiles au debug à distance :
 *   - README.txt           : explication + email destinataire
 *   - audit-log.jsonl      : journal RGPD (admin uniquement, RGPD-sensible)
 *   - runtime/*.log        : logs Electron main + daemon Hono + Next.js
 *   - system-info.json     : OS, versions, chemins, PATH
 *   - app-config.json      : config courante (chemins, isAdmin, modèle)
 *   - data-inventory.json  : listing data/ (chemins + tailles + mtime, pas de contenu)
 *
 * Le contenu des dossiers candidats n'est jamais inclus (RGPD).
 */
import {
  existsSync,
  readFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { resolve, relative, join } from "node:path";
import { platform, release, arch, hostname, type } from "node:os";
import JSZip from "jszip";

const SUPPORT_EMAIL = "nicolas.cleton@petitmaker.fr";
const RUNTIME_LOG_NAMES = ["electron-main", "daemon", "next"];
const INVENTORY_DIRS = ["evaluations", "calibrage", "candidatures-7e", "candidatures-6e"];
const INVENTORY_MAX_FILES = 5000;

interface BuildOpts {
  isAdmin: boolean;
  logDir?: string;
  appVersion: string;
  auditLogDir?: string;
}

interface InventoryEntry {
  relativePath: string;
  sizeBytes: number;
  mtime: string;
}

export async function buildDebugBundle(
  dataDir: string,
  opts: BuildOpts
): Promise<{ buffer: Buffer; filename: string }> {
  const zip = new JSZip();
  const generatedAt = new Date();
  const stamp = generatedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `oif-eval-debug-${stamp}.zip`;

  zip.file("README.txt", buildReadme(generatedAt, opts));

  if (opts.isAdmin) {
    const auditPath = opts.auditLogDir
      ? resolve(opts.auditLogDir, "audit-log.jsonl")
      : resolve(dataDir, ".claude", "audit-log.jsonl");
    if (existsSync(auditPath)) {
      zip.file("audit-log.jsonl", readFileSync(auditPath));
    }
  }

  if (opts.logDir && existsSync(opts.logDir)) {
    for (const name of RUNTIME_LOG_NAMES) {
      const logFile = resolve(opts.logDir, `${name}.log`);
      if (existsSync(logFile)) {
        zip.file(`runtime/${name}.log`, readFileSync(logFile));
      }
      const oldFile = resolve(opts.logDir, `${name}.log.old`);
      if (existsSync(oldFile)) {
        zip.file(`runtime/${name}.log.old`, readFileSync(oldFile));
      }
    }
  }

  zip.file("system-info.json", JSON.stringify(buildSystemInfo(dataDir, opts, generatedAt), null, 2));

  const configPath = resolve(dataDir, ".claude", "app-config.json");
  if (existsSync(configPath)) {
    zip.file("app-config.json", readFileSync(configPath));
  }

  zip.file(
    "data-inventory.json",
    JSON.stringify(buildInventory(dataDir), null, 2)
  );

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, filename };
}

function buildReadme(generatedAt: Date, opts: BuildOpts): string {
  return [
    "OIF-Eval - Fichier de diagnostic",
    "================================",
    "",
    `Généré le : ${generatedAt.toISOString()}`,
    `Version app : ${opts.appVersion}`,
    `Journal RGPD inclus : ${opts.isAdmin ? "oui (utilisateur admin)" : "non (utilisateur standard)"}`,
    "",
    "Comment l'utiliser :",
    `  Envoyez ce fichier ZIP par email à ${SUPPORT_EMAIL}`,
    "  en décrivant le problème rencontré (action effectuée, message d'erreur,",
    "  heure approximative).",
    "",
    "Contenu :",
    "  - README.txt           ce fichier",
    "  - audit-log.jsonl      journal de traçabilité RGPD (admin uniquement)",
    "  - runtime/*.log        logs techniques (Electron, daemon, Next.js)",
    "  - system-info.json     OS, versions, chemins",
    "  - app-config.json      configuration de l'app",
    "  - data-inventory.json  liste des fichiers présents (sans contenu)",
    "",
    "Aucun contenu de dossier candidat n'est inclus dans cette archive.",
    "",
  ].join("\n");
}

function buildSystemInfo(dataDir: string, opts: BuildOpts, generatedAt: Date) {
  return {
    generatedAt: generatedAt.toISOString(),
    appVersion: opts.appVersion,
    platform: platform(),
    osType: type(),
    osRelease: release(),
    arch: arch(),
    hostname: hostname(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron ?? null,
    v8Version: process.versions.v8,
    cwd: process.cwd(),
    dataDir,
    logDir: opts.logDir ?? null,
    daemonPid: process.pid,
    daemonUptimeSeconds: Math.round(process.uptime()),
    env: {
      FAE_DAEMON_PORT: process.env.FAE_DAEMON_PORT ?? null,
      FAE_NEXT_PORT: process.env.FAE_NEXT_PORT ?? null,
      OIF_LOG_DIR: process.env.OIF_LOG_DIR ?? null,
      OIF_APP_VERSION: process.env.OIF_APP_VERSION ?? null,
      NODE_ENV: process.env.NODE_ENV ?? null,
    },
  };
}

function buildInventory(dataDir: string): {
  rootsScanned: string[];
  totalFiles: number;
  truncated: boolean;
  entries: InventoryEntry[];
} {
  const entries: InventoryEntry[] = [];
  const rootsScanned: string[] = [];
  let truncated = false;

  for (const sub of INVENTORY_DIRS) {
    const root = resolve(dataDir, sub);
    if (!existsSync(root)) continue;
    rootsScanned.push(sub);
    const stack: string[] = [root];
    while (stack.length > 0) {
      if (entries.length >= INVENTORY_MAX_FILES) {
        truncated = true;
        break;
      }
      const dir = stack.pop()!;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(full);
        } else if (st.isFile()) {
          if (entries.length >= INVENTORY_MAX_FILES) {
            truncated = true;
            break;
          }
          entries.push({
            relativePath: relative(dataDir, full),
            sizeBytes: st.size,
            mtime: st.mtime.toISOString(),
          });
        }
      }
    }
  }

  return {
    rootsScanned,
    totalFiles: entries.length,
    truncated,
    entries,
  };
}
