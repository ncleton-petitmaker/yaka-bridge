#!/usr/bin/env node
/**
 * Smoke test : valide que pdfjs-dist tourne côté Node et qu'on peut
 * extraire le texte avec coords depuis un PDF réel.
 */
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error("Usage: node test-pdfjs-node.mjs <chemin.pdf>");
  process.exit(1);
}

const data = new Uint8Array(await readFile(pdfPath));
const doc = await getDocument({
  data,
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
}).promise;
console.log(`PDF: ${doc.numPages} pages`);

for (let i = 1; i <= Math.min(doc.numPages, 2); i++) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  console.log(`\n=== Page ${i} (${viewport.width.toFixed(0)}x${viewport.height.toFixed(0)}) ===`);
  console.log(`Items: ${tc.items.length}`);
  for (const it of tc.items.slice(0, 8)) {
    if (!("str" in it)) continue;
    const [a, b, c, d, e, f] = it.transform;
    console.log(`  "${it.str.slice(0, 40)}" x=${e.toFixed(1)} y=${f.toFixed(1)} w=${it.width.toFixed(1)} h=${(it.height || 0).toFixed(1)}`);
  }
}
await doc.destroy();
