/**
 * Tarifs Anthropic (USD par million de tokens) et utilitaires d'agrégation.
 * Utilisés par le daemon pour calculer le coût d'un run à partir des events
 * `usage` émis par le parser.
 *
 * La grille est externalisée dans `data/.claude/pricing.json` (modifiable à
 * chaud, mis à jour par le bouton "Actualiser les tarifs" qui lance un run
 * Claude avec WebFetch sur la doc Anthropic). Si le JSON est absent ou
 * corrompu, on fallback sur la grille en dur ci-dessous (mai 2026).
 *
 * Modèles inconnus -> fallback Sonnet (par sécurité, plutôt sous-estimer un
 * peu Opus que sur-estimer Haiku).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface ModelTariff {
  /** Tarif input ($/M tokens) pour un input non caché. */
  input: number;
  /** Tarif output ($/M tokens). */
  output: number;
  /** Tarif read d'un input déjà caché ($/M tokens). */
  cache_read: number;
  /** Tarif d'écriture cache ephemère 5 minutes ($/M tokens). */
  cache_create_5m: number;
  /**
   * Multiplicateur appliqué à `cache_create_5m` pour estimer le tarif du
   * cache 1h. Approximation 8x faute de tarif officiel publié par Anthropic
   * pour la TTL 1h en 2026 (le 1h coûte plus cher car il occupe le cache plus
   * longtemps). À ajuster si la grille change.
   */
  cache_create_1h_multiplier: number;
}

/**
 * Grille tarifaire en dur (fallback). Mai 2026.
 * Référence : https://docs.claude.com/en/docs/about-claude/pricing
 * Mise à jour via l'agent /api/pricing/refresh (qui écrase data/.claude/pricing.json).
 */
const DEFAULT_TARIFFS: Record<string, ModelTariff> = {
  // Famille 4.x (génération actuelle)
  "claude-opus-4-7":   { input: 5.0,  output: 25.0, cache_read: 0.5,  cache_create_5m: 6.25, cache_create_1h_multiplier: 1.6 },
  "claude-opus-4-6":   { input: 5.0,  output: 25.0, cache_read: 0.5,  cache_create_5m: 6.25, cache_create_1h_multiplier: 1.6 },
  "claude-opus-4-5":   { input: 5.0,  output: 25.0, cache_read: 0.5,  cache_create_5m: 6.25, cache_create_1h_multiplier: 1.6 },
  "claude-opus-4":     { input: 15.0, output: 75.0, cache_read: 1.5,  cache_create_5m: 18.75, cache_create_1h_multiplier: 1.6 },
  "claude-sonnet-4-7": { input: 3.0,  output: 15.0, cache_read: 0.3,  cache_create_5m: 3.75, cache_create_1h_multiplier: 1.6 },
  "claude-sonnet-4-6": { input: 3.0,  output: 15.0, cache_read: 0.3,  cache_create_5m: 3.75, cache_create_1h_multiplier: 1.6 },
  "claude-sonnet-4-5": { input: 3.0,  output: 15.0, cache_read: 0.3,  cache_create_5m: 3.75, cache_create_1h_multiplier: 1.6 },
  "claude-sonnet-4":   { input: 3.0,  output: 15.0, cache_read: 0.3,  cache_create_5m: 3.75, cache_create_1h_multiplier: 1.6 },
  "claude-haiku-4-7":  { input: 1.0,  output: 5.0,  cache_read: 0.1,  cache_create_5m: 1.25, cache_create_1h_multiplier: 1.6 },
  "claude-haiku-4-6":  { input: 1.0,  output: 5.0,  cache_read: 0.1,  cache_create_5m: 1.25, cache_create_1h_multiplier: 1.6 },
  "claude-haiku-4-5":  { input: 1.0,  output: 5.0,  cache_read: 0.1,  cache_create_5m: 1.25, cache_create_1h_multiplier: 1.6 },
  // Famille 3.x (legacy, encore exposée par certaines configs)
  "claude-3-7-sonnet": { input: 3.0,  output: 15.0, cache_read: 0.3,  cache_create_5m: 3.75, cache_create_1h_multiplier: 1.6 },
  "claude-3-5-sonnet": { input: 3.0,  output: 15.0, cache_read: 0.3,  cache_create_5m: 3.75, cache_create_1h_multiplier: 1.6 },
  "claude-3-5-haiku":  { input: 0.8,  output: 4.0,  cache_read: 0.08, cache_create_5m: 1.0,  cache_create_1h_multiplier: 1.6 },
  "claude-3-opus":     { input: 15.0, output: 75.0, cache_read: 1.5,  cache_create_5m: 18.75, cache_create_1h_multiplier: 1.6 },
  "claude-3-haiku":    { input: 0.25, output: 1.25, cache_read: 0.03, cache_create_5m: 0.30, cache_create_1h_multiplier: 1.6 },
};

interface PricingFile {
  updatedAt?: string;
  source?: string;
  tariffs: Record<string, ModelTariff>;
}

let _DATA_DIR: string | null = null;
let _cached: { tariffs: Record<string, ModelTariff>; mtimeMs: number; updatedAt: string | null; source: string | null } | null = null;

export function setPricingDataDir(dataDir: string): void {
  _DATA_DIR = dataDir;
  _cached = null;
}
export function pricingJsonPath(dataDir?: string): string {
  const d = dataDir ?? _DATA_DIR;
  if (!d) throw new Error("pricing.ts : dataDir non initialisé (appeler setPricingDataDir)");
  return resolve(d, ".claude", "pricing.json");
}

function loadPricing(): Record<string, ModelTariff> {
  if (!_DATA_DIR) return DEFAULT_TARIFFS;
  const p = pricingJsonPath();
  if (!existsSync(p)) return DEFAULT_TARIFFS;
  let mtimeMs = 0;
  try { mtimeMs = statSync(p).mtimeMs; } catch { return DEFAULT_TARIFFS; }
  if (_cached && _cached.mtimeMs === mtimeMs) return _cached.tariffs;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as PricingFile;
    if (parsed && typeof parsed.tariffs === "object" && parsed.tariffs) {
      _cached = {
        tariffs: { ...DEFAULT_TARIFFS, ...parsed.tariffs },
        mtimeMs,
        updatedAt: parsed.updatedAt ?? null,
        source: parsed.source ?? null,
      };
      return _cached.tariffs;
    }
  } catch {
    // fallback silencieux
  }
  return DEFAULT_TARIFFS;
}

export function getPricingMetadata(): { updatedAt: string | null; source: string | null; usingDefault: boolean } {
  loadPricing();
  return {
    updatedAt: _cached?.updatedAt ?? null,
    source: _cached?.source ?? null,
    usingDefault: _cached === null,
  };
}

export function writePricingFromAgent(payload: PricingFile, dataDir: string): void {
  const p = pricingJsonPath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  const content: PricingFile = {
    updatedAt: payload.updatedAt ?? new Date().toISOString(),
    source: payload.source,
    tariffs: payload.tariffs,
  };
  writeFileSync(p, JSON.stringify(content, null, 2), "utf8");
  _cached = null;
}

/**
 * Exposé pour compat : lecture (read-only) des tarifs courants. Toujours
 * relire via la fonction pour bénéficier du hot reload sur le JSON.
 */
export function getModelTariffs(): Record<string, ModelTariff> {
  return loadPricing();
}

// Compat ancienne API : objet figé qui proxy vers loadPricing().
export const MODEL_TARIFFS: Record<string, ModelTariff> = new Proxy({} as Record<string, ModelTariff>, {
  get: (_t, key: string) => loadPricing()[key],
  ownKeys: () => Object.keys(loadPricing()),
  getOwnPropertyDescriptor: (_t, key: string) => {
    const v = loadPricing()[key as string];
    if (v === undefined) return undefined;
    return { configurable: true, enumerable: true, value: v };
  },
});

function getFallback(): ModelTariff {
  return loadPricing()["claude-sonnet-4-6"] ?? DEFAULT_TARIFFS["claude-sonnet-4-6"];
}

/**
 * Normalise un nom de modèle (Anthropic envoie parfois `claude-opus-4-7-20260101`
 * ou avec suffixe alias). On strip toute version et on tente un match.
 */
function normalizeModel(model: string | undefined | null, tariffs: Record<string, ModelTariff>): string {
  if (!model) return "";
  const m = model.toLowerCase();
  if (tariffs[m]) return m;
  const stripped = m.replace(/-\d{8}$/, "");
  if (tariffs[stripped]) return stripped;
  for (const key of Object.keys(tariffs)) {
    if (m.startsWith(key)) return key;
  }
  return "";
}

export function tariffFor(model: string | undefined | null): ModelTariff {
  const tariffs = loadPricing();
  const norm = normalizeModel(model, tariffs);
  return tariffs[norm] ?? getFallback();
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create_5m: number;
  cache_create_1h: number;
  cost_usd: number;
  last_model: string | null;
}

export function emptyTotals(): UsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_create_5m: 0,
    cache_create_1h: 0,
    cost_usd: 0,
    last_model: null,
  };
}

/**
 * Calcule le coût USD d'un set de totaux pour un modèle donné. Retourne
 * un nombre positif arrondi à 6 décimales (assez fin pour un appel unique,
 * pas trop bruité côté UI).
 */
export function computeCostUsd(
  totals: Omit<UsageTotals, "cost_usd" | "last_model">,
  model: string | null
): number {
  const t = tariffFor(model);
  const cost =
    (totals.input_tokens * t.input) / 1_000_000 +
    (totals.output_tokens * t.output) / 1_000_000 +
    (totals.cache_read * t.cache_read) / 1_000_000 +
    (totals.cache_create_5m * t.cache_create_5m) / 1_000_000 +
    (totals.cache_create_1h * t.cache_create_5m * t.cache_create_1h_multiplier) /
      1_000_000;
  return Number(cost.toFixed(6));
}
