#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRINT_ONLY = process.argv.includes("--print");
const SKIP_SYNC = process.argv.includes("--skip-sync");

const prompt = `Utilise la skill yaka-bridge-onboard.

Tu es dans le repo yaka-bridge. Objectif : guider un utilisateur novice qui vient
d'importer le repo pour le rendre opérationnel avec Codex.

Commence par vérifier les skills repo-local et le dossier Projets/, puis pose
les questions de cadrage : dossier entreprise local, client, GitHub, modules,
design system, VPS OVH ou VPS existant, domaine, DNS, Supabase, Bridge,
sauvegardes et sécurité. Ne demande jamais de secrets dans le chat. Si besoin,
délègue aux skills yaka-bridge-version-modules, yaka-bridge-new-client-vps,
yaka-bridge-create-module et yaka-bridge-refactor-design-system.`;

if (!SKIP_SYNC) {
  run("node", ["scripts/sync-codex-skills.mjs"], {
    allowFailure: false,
    quiet: PRINT_ONLY,
  });
  run("node", ["scripts/sync-codex-skills.mjs", "--check"], {
    allowFailure: false,
    quiet: PRINT_ONLY,
  });
}

if (PRINT_ONLY) {
  console.log(prompt);
  process.exit(0);
}

const codexAvailable = spawnSync("codex", ["--version"], {
  cwd: ROOT,
  stdio: "ignore",
});

if (codexAvailable.status !== 0) {
  console.error("Codex CLI is not available in PATH.");
  console.error("Open this repository in Codex Desktop and send this prompt:");
  console.error("");
  console.error(prompt);
  process.exit(1);
}

const result = spawnSync("codex", ["--cd", ROOT, prompt], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(result.status ?? 1);

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: options.quiet ? "utf8" : undefined,
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.status !== 0 && !options.allowFailure) {
    if (options.quiet) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }
  return result;
}
