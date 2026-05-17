#!/usr/bin/env node
/**
 * Patch un PDF pour forcer /PageMode /UseNone dans le Catalog.
 *
 * Effet : à l'ouverture du PDF (Adobe Reader, Preview, Chrome, Edge, etc.)
 * le panneau latéral (vignettes / signets / pièces jointes) reste FERMÉ
 * par défaut. L'utilisateur peut toujours l'ouvrir manuellement.
 *
 * À appeler en post-traitement après page.pdf() de Puppeteer (qui ne
 * supporte pas PageMode dans ses options).
 *
 * Usage : node scripts/patch-pdf-pagemode.mjs <chemin.pdf>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument, PDFName } from "pdf-lib";

const target = process.argv[2];
if (!target) {
  console.error("Usage : node scripts/patch-pdf-pagemode.mjs <fichier.pdf>");
  process.exit(1);
}

const buf = readFileSync(target);
const doc = await PDFDocument.load(buf, { updateMetadata: false });
doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseNone"));

const out = await doc.save();
writeFileSync(target, out);
console.log(
  `✓ ${target} patché : /PageMode /UseNone (panneau latéral fermé par défaut)`
);
