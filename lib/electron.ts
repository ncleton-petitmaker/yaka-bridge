/**
 * Wrappers typés sur `window.oifEval.*` exposés par `electron/preload.cjs`.
 *
 * Utilisable depuis tout composant React ; renvoie un fallback sentinel
 * `{ ok: false, unavailable: true }` quand l'app tourne hors Electron
 * (mode `next dev` pur, browser preview…), pour que les pages se
 * comportent proprement (input texte manuel en fallback).
 */

export interface SelectDirectoryOpts {
  /** Titre du picker natif (défaut "Choisir un dossier"). */
  title?: string;
  /** Texte du bouton de validation (défaut "Sélectionner"). */
  buttonLabel?: string;
  /** Path de départ ouvert par défaut (défaut : dossier Documents). */
  defaultPath?: string;
  /**
   * Sous-dossiers à créer automatiquement sous le dossier choisi. Pattern
   * OIF-eval : l'utilisateur choisit la racine, l'app crée
   * `input/`, `output/`, `audit-log/`, etc. Path traversal et chemins
   * absolus sont rejetés côté main.
   */
  subdirs?: string[];
  /** Si true (défaut), crée le dossier s'il n'existe pas encore. */
  createIfMissing?: boolean;
}

export type SelectDirectoryResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string }
  | { ok: false; unavailable: true };

interface OifEvalBridge {
  isElectron: boolean;
  selectDirectory(opts?: SelectDirectoryOpts): Promise<SelectDirectoryResult>;
  openFile(absPath: string): Promise<{ ok: boolean; error?: string }>;
  revealFile(absPath: string): Promise<{ ok: boolean; error?: string }>;
  saveDebugBundle(
    buffer: ArrayBuffer,
    filename: string
  ): Promise<{ ok: boolean; path?: string; error?: string }>;
  version(): string;
}

function bridge(): OifEvalBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { oifEval?: OifEvalBridge };
  return w.oifEval ?? null;
}

export function isElectron(): boolean {
  return !!bridge()?.isElectron;
}

export async function selectDirectory(
  opts: SelectDirectoryOpts = {}
): Promise<SelectDirectoryResult> {
  const b = bridge();
  if (!b) return { ok: false, unavailable: true };
  try {
    return await b.selectDirectory(opts);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function openFile(absPath: string): Promise<void> {
  const b = bridge();
  if (!b) return;
  await b.openFile(absPath);
}

export async function revealFile(absPath: string): Promise<void> {
  const b = bridge();
  if (!b) return;
  await b.revealFile(absPath);
}
