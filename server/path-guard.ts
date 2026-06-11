/**
 * Confinement de chemins pour les runs agentiques.
 *
 * Sous Codex, la barrière réelle est `--sandbox` + le périmètre `--add-dir`.
 * Ce module ajoute une validation côté daemon : `cwd` et chaque `--add-dir`
 * doivent résoudre SOUS une racine autorisée (dataDir + dossiers configurés).
 * On résout via `realpathSync.native` pour neutraliser `..` et les symlinks
 * (fail-closed : si la résolution réelle échappe, on refuse).
 *
 * Aligné sur la logique historique du bridge (bridge/runtime.ts).
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AppConfig } from "./app-config.js";

/** Racines d'écriture autorisées pour un run : dataDir + dossiers configurés. */
export function allowedRunRoots(dataDir: string, cfg: AppConfig): string[] {
  const roots = new Set<string>();
  roots.add(resolve(dataDir));
  if (cfg.auditLogDir) roots.add(resolve(cfg.auditLogDir));
  if (cfg.outputDir) roots.add(resolve(cfg.outputDir));
  if (cfg.inputDir) roots.add(resolve(cfg.inputDir));
  return Array.from(roots);
}

function relInside(rootPath: string, resolved: string): boolean {
  const rel = relative(rootPath, resolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Vrai si `target` résout dans l'une des racines (avec garde realpath). */
export function isInsideRoots(target: string, roots: string[]): boolean {
  const resolved = resolve(target);
  for (const root of roots) {
    const rootPath = resolve(root);
    if (!relInside(rootPath, resolved)) continue;
    // Chemin pas encore créé : le check nominal suffit (pas de symlink à suivre).
    if (!existsSync(resolved)) return true;
    // Chemin existant : on exige que la résolution réelle reste contenue.
    try {
      const realRoot = realpathSync.native(rootPath);
      const realResolved = realpathSync.native(resolved);
      if (relInside(realRoot, realResolved)) return true;
    } catch {
      // fail-closed : impossible de prouver le confinement → on refuse.
    }
  }
  return false;
}

/** Renvoie le chemin résolu s'il est confiné, sinon throw. */
export function assertInsideRoots(target: string, roots: string[], label = target): string {
  if (isInsideRoots(target, roots)) return resolve(target);
  throw new Error(`Chemin hors racine autorisée: ${label}`);
}
