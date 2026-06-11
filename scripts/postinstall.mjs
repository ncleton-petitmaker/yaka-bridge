#!/usr/bin/env node
/**
 * Postinstall hook : déploie la structure du dossier de travail (data/) à partir
 * du template (data-template/) si data/ n'existe pas. Copie aussi les skills
 * depuis skills-template/_global/ dans data/.claude/skills/_global/.
 *
 * Idempotent : ne réécrase pas un data/ existant. À l'admin de retirer data/
 * pour forcer un redéploiement (et il perd ses évaluations).
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, chmodSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(ROOT, "data");
const TEMPLATE = resolve(ROOT, "data-template");
const SKILLS_TEMPLATE = resolve(ROOT, "skills-template", "_global");

function copyRecursive(src, dst) {
  const stats = statSync(src);
  if (stats.isDirectory()) {
    if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dst, entry));
    }
  } else if (stats.isFile()) {
    if (!existsSync(dst)) {
      copyFileSync(src, dst);
      // hooks sont exécutables
      if (dst.includes("/hooks/") && dst.endsWith(".mjs")) {
        try { chmodSync(dst, 0o755); } catch {}
      }
    }
  }
}

if (existsSync(DATA)) {
  console.log(`[postinstall] data/ existe déjà, skip déploiement`);
} else {
  console.log(`[postinstall] déploiement de data-template/ → data/`);
  copyRecursive(TEMPLATE, DATA);
}

// Skills globaux : on s'assure qu'ils sont à jour à chaque postinstall
// (utile quand on met à jour les règles globales)
const SKILLS_DST = resolve(DATA, ".claude", "skills", "_global");
if (existsSync(SKILLS_TEMPLATE)) {
  if (!existsSync(SKILLS_DST)) mkdirSync(SKILLS_DST, { recursive: true });
  for (const entry of readdirSync(SKILLS_TEMPLATE)) {
    if (!entry.endsWith(".skill.md")) continue;
    const src = join(SKILLS_TEMPLATE, entry);
    const dst = join(SKILLS_DST, entry);
    // pour les skills, on écrase systématiquement (source de vérité = skills-template/)
    copyFileSync(src, dst);
    console.log(`[postinstall] skill copié : ${entry}`);
  }
}

console.log(`[postinstall] OK. Dossier de travail : ${DATA}`);
