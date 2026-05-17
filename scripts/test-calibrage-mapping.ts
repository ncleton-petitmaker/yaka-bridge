#!/usr/bin/env tsx
/**
 * Test de non-régression du mapping libellé colonne xlsx -> Q skill.
 *
 * Importe le bundle de test (xlsx 6e + 3 dossiers) avec le skill 7e actif
 * et vérifie que :
 *   - le mapping détecte bien plus de 30 colonnes
 *   - aucune valeur dépassant le barème xlsx ne traîne dans les scoresHumains
 *
 * Lance manuellement : `npx tsx scripts/test-calibrage-mapping.ts`
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { importBundle, deleteImport } from "../server/calibrage-imports.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
// On utilise le bundle 6e complet (50 dossiers) plutôt que le bundle de 3
// dossiers, qui a un xlsx tronqué à 3 lignes et déclencherait le filet
// minimum de 5 dossiers du parser. L'objet du test est le mapping libellé,
// pas le seuil de dossiers.
const BUNDLE_PATH = "/Users/nicolascleton/Desktop/calibrage-test-6e.zip";
const FALLBACK_PATH = "/Users/nicolascleton/Desktop/calibrage-test-3-dossiers.zip";

async function main(): Promise<void> {
  const path = existsSync(BUNDLE_PATH) ? BUNDLE_PATH : FALLBACK_PATH;
  if (!existsSync(path)) {
    console.error(
      `✗ Aucun bundle de test trouvé (essayé ${BUNDLE_PATH} puis ${FALLBACK_PATH}).`
    );
    process.exit(1);
  }
  const buf = readFileSync(path);
  console.log(`Test 1 : import ${basename(path)} avec skill actif`);

  const result = await importBundle(DATA_DIR, buf, "test-mapping.zip");
  if (!result.ok) {
    console.error(`✗ Import refusé : ${result.error}`);
    if (result.warnings) {
      for (const w of result.warnings) console.error(`  warn: ${w}`);
    }
    process.exit(1);
  }
  const bundle = result.data;
  const cols = bundle.colonnes ?? [];
  const matched = cols.filter((c) => c.matchedSkillQId != null).length;
  const matchedHigh = cols.filter(
    (c) => c.matchedSkillQId != null && c.matchScore >= 0.6
  ).length;
  const matchedLow = matched - matchedHigh;
  const orphans = cols.length - matched;
  console.log(
    `  Colonnes détectées : ${cols.length}, matchées : ${matched} (haut score : ${matchedHigh}, faible : ${matchedLow}), orphelines : ${orphans}`
  );

  let failed = false;

  if (cols.length === 0) {
    console.error("✗ Aucune colonne détectée");
    failed = true;
  }
  if (matched < 30) {
    console.error(`✗ Mapping trop bas : ${matched} < 30 colonnes matchées`);
    failed = true;
  }

  // Vérifie qu'aucune valeur ne dépasse le barème (filet de sécurité du parser)
  for (const d of bundle.dossiers) {
    for (const col of cols) {
      if (col.baremeXlsxMax == null) continue;
      const val = d.scoresHumains[`col_${col.positionXlsx}`];
      if (val != null && val > col.baremeXlsxMax * 1.05) {
        console.error(
          `✗ Valeur aberrante : dossier ${d.reference} col_${col.positionXlsx} = ${val} > barème ${col.baremeXlsxMax}`
        );
        failed = true;
      }
    }
  }

  // Vérifie qu'on a bien un barème pour la quasi-totalité des colonnes
  const sansBareme = cols.filter((c) => c.baremeXlsxMax == null).length;
  if (sansBareme > cols.length / 2) {
    console.error(
      `✗ Trop de colonnes sans barème parsable : ${sansBareme}/${cols.length}`
    );
    failed = true;
  } else if (sansBareme > 0) {
    console.log(
      `  Note : ${sansBareme} colonne(s) sans barème dans le libellé (acceptable)`
    );
  }

  // Cleanup : supprime le bundle de test
  try {
    deleteImport(DATA_DIR, bundle.importId);
  } catch {
    // ignore
  }

  if (failed) {
    process.exit(1);
  }
  console.log(`✓ Test mapping OK (${matched}/${cols.length} colonnes matchées)`);
}

main().catch((e) => {
  console.error(`✗ Exception : ${(e as Error).message}`);
  console.error((e as Error).stack);
  process.exit(1);
});
