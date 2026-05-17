#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// Import compilé pour éviter besoin de tsx
import("../node_modules/tsx/dist/loader.mjs").catch(() => {});
const { getHighlightedPdf, normalize } = await import("../server/pdf-highlight.ts");

const pdf = process.argv[2];
const quote = process.argv[3];
if (!pdf || !quote) {
  console.error("Usage: tsx scripts/test-highlight.mjs <pdf> <quote>");
  process.exit(1);
}
const cacheDir = resolve(tmpdir(), "oif-test-highlight");
console.log(`Quote normalisé: "${normalize(quote)}"`);
const result = await getHighlightedPdf(pdf, quote, cacheDir);
const outPath = resolve(tmpdir(), `highlighted-${Date.now()}.pdf`);
await writeFile(outPath, result.bytes);
console.log(`Matches trouvés: ${result.matchCount}`);
console.log(`PDF de sortie: ${outPath}`);
console.log(`Cached: ${result.cached}`);
