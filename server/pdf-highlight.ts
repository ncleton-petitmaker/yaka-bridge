/**
 * Génère un PDF avec annotations /Highlight injectées sur les passages cités.
 *
 * Pipeline :
 *   1. Extraction du texte+coordonnées via pdfjs-dist (Node-side, sans worker).
 *   2. Fuzzy match du quote contre les text items normalisés
 *      (NFKD + diacritiques retirés + ligatures décomposées + ponctuation lissée).
 *   3. Reconstruction des rectangles par ligne (groupes d'items à Y similaire).
 *   4. Injection d'annotations /Highlight via pdf-lib (dict bas niveau car
 *      pdf-lib n'a pas d'API native pour Highlight).
 *
 * Cache : keyed par `sha256(file_path + mtime + quote)`. Le PDF modifié est
 * écrit une fois sur disque, servi directement aux clics suivants.
 *
 * Robuste aux différences typiques entre quote Claude et texte PDF :
 *   "oeuvre" → matche "œuvre"
 *   "Haiti" → matche "Haïti"
 *   "Pays de mise en oeuvre du projet : Haiti" → matche "Pays de mise en
 *   œuvre du projet *\nHaïti" (espaces multiples + ponctuation différente).
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { PDFDocument, PDFName, PDFArray, PDFNumber } from "pdf-lib";

// pdfjs-dist en Node bundlé : le build "legacy" essaie d'auto-polyfiller
// via require() dynamique, ce qui plante après esbuild. On pose les stubs
// AVANT le dynamic import et on utilise le build "legacy" qui est conçu
// pour Node (le build moderne refuse Node avec un warning).
let _pdfjsGetDocument: typeof import("pdfjs-dist/legacy/build/pdf.mjs").getDocument | null = null;
async function loadPdfjs() {
  if (_pdfjsGetDocument) return _pdfjsGetDocument;
  const g = globalThis as Record<string, unknown>;
  if (!g.DOMMatrix) {
    g.DOMMatrix = class {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      constructor(init?: number[]) {
        if (Array.isArray(init) && init.length === 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
        }
      }
      multiplySelf() { return this; }
      translateSelf() { return this; }
      scaleSelf() { return this; }
      inverse() { return this; }
      transformPoint(p: { x?: number; y?: number }) { return { x: p.x ?? 0, y: p.y ?? 0 }; }
    };
  }
  if (!g.Path2D) {
    g.Path2D = class {
      addPath() {} closePath() {} moveTo() {} lineTo() {}
      bezierCurveTo() {} quadraticCurveTo() {} arc() {} rect() {}
    };
  }
  if (!g.ImageData) {
    g.ImageData = class {
      data: Uint8ClampedArray; width: number; height: number;
      constructor(w: number, h: number) {
        this.width = w; this.height = h;
        this.data = new Uint8ClampedArray(w * h * 4);
      }
    };
  }
  // Dynamic import APRÈS pose des polyfills, sinon pdfjs evalue les classes
  // au module-load et plante. Le `legacy` build est requis pour Node.
  // @ts-ignore - types non exposés sur le chemin legacy
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  _pdfjsGetDocument = mod.getDocument;
  return _pdfjsGetDocument;
}

interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface PageData {
  page: number;
  height: number;
  items: TextItem[];
}
interface MatchedItems {
  page: number;
  pageHeight: number;
  items: TextItem[];
}

/** Normalise pour comparaison : retire diacritiques, ligatures, ponctuation
 *  exotique, met en lowercase, collapse whitespace. Garde la longueur
 *  comparable côté input et côté PDF pour que indexOf reste utile. */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // diacritiques combinants
    .replace(/œ/gi, "oe")
    .replace(/æ/gi, "ae")
    .replace(/['’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[*•·]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

async function extractPages(pdfBytes: Uint8Array): Promise<PageData[]> {
  const getDocument = await loadPdfjs();
  const doc = await getDocument({
    data: pdfBytes,
    useWorkerFetch: false,
    useSystemFonts: true,
    disableFontFace: true,
  } as Parameters<typeof getDocument>[0]).promise;
  const pages: PageData[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items: TextItem[] = [];
      for (const it of tc.items) {
        if (!("str" in it) || typeof it.str !== "string" || !it.str) continue;
        const h = (it as { height?: number }).height ?? 0;
        const fallbackH = Math.abs(it.transform[3] as number) || 10;
        items.push({
          str: it.str as string,
          x: it.transform[4] as number,
          y: it.transform[5] as number,
          width: it.width as number,
          height: h > 0 ? h : fallbackH,
        });
      }
      pages.push({ page: i, height: viewport.height, items });
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

/** Cherche le quote (normalisé) dans chaque page et retourne les items
 *  couverts pour chaque match. */
function findMatches(pages: PageData[], quote: string): MatchedItems[] {
  const normQuote = normalize(quote);
  if (normQuote.length < 3) return [];
  const matches: MatchedItems[] = [];
  for (const p of pages) {
    let concat = "";
    const itemMap: number[] = [];
    for (let i = 0; i < p.items.length; i++) {
      const n = normalize(p.items[i].str);
      for (let c = 0; c < n.length; c++) itemMap.push(i);
      concat += n;
      // séparateur entre items pour éviter de coller les mots de 2 items
      // (mais on n'a pas toujours d'espace en PDF entre items consécutifs)
      concat += " ";
      itemMap.push(i);
    }
    let pos = 0;
    while (true) {
      const idx = concat.indexOf(normQuote, pos);
      if (idx === -1) break;
      const startItem = itemMap[idx];
      const endItem = itemMap[Math.min(idx + normQuote.length - 1, itemMap.length - 1)] ?? startItem;
      const slice = p.items.slice(startItem, endItem + 1);
      if (slice.length > 0) {
        matches.push({ page: p.page, pageHeight: p.height, items: slice });
      }
      pos = idx + normQuote.length;
      if (matches.length >= 20) break; // protège contre les quotes ultra-communs
    }
    if (matches.length >= 20) break;
  }
  return matches;
}

/** Regroupe les items d'un match par ligne (Y similaire) et retourne
 *  un rectangle [x1,y1,x2,y2] par ligne (bottom-left + top-right). */
function rectsForMatch(m: MatchedItems): { rect: [number, number, number, number] }[] {
  if (m.items.length === 0) return [];
  // Tri par Y descendant (les PDFs ont Y bottom-up, ligne haute = grand Y).
  // Groupe par lignes si abs(Y - prev) < demi-hauteur.
  const sorted = [...m.items].sort((a, b) => b.y - a.y);
  const lines: TextItem[][] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - it.y) < it.height * 0.5) {
      last.push(it);
    } else {
      lines.push([it]);
    }
  }
  const rects: { rect: [number, number, number, number] }[] = [];
  for (const line of lines) {
    let xMin = Infinity, xMax = -Infinity, yBottom = Infinity, yTop = -Infinity;
    for (const it of line) {
      xMin = Math.min(xMin, it.x);
      xMax = Math.max(xMax, it.x + it.width);
      yBottom = Math.min(yBottom, it.y - it.height * 0.15);
      yTop = Math.max(yTop, it.y + it.height);
    }
    if (xMin < xMax && yBottom < yTop) {
      rects.push({ rect: [xMin, yBottom, xMax, yTop] });
    }
  }
  return rects;
}

/** Injecte les annotations /Highlight dans le PDF. Couleur jaune doux,
 *  opacité 0.4 (style stabilo). */
async function injectHighlights(
  pdfBytes: Uint8Array,
  matches: MatchedItems[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  for (const m of matches) {
    const page = doc.getPage(m.page - 1);
    const rects = rectsForMatch(m);
    for (const { rect } of rects) {
      const [x1, y1, x2, y2] = rect;
      // QuadPoints PDF spec : top-left, top-right, bottom-left, bottom-right
      // (chaque rectangle = 8 floats). Beaucoup de readers tolèrent l'ordre
      // mais Adobe est strict.
      const quadPoints = [x1, y2, x2, y2, x1, y1, x2, y1];
      const annot = doc.context.obj({
        Type: "Annot",
        Subtype: "Highlight",
        Rect: [x1, y1, x2, y2],
        QuadPoints: quadPoints,
        C: [1, 0.93, 0.4],
        CA: 0.4,
        F: 4, // print flag
        Border: [0, 0, 0],
      });
      const annotRef = doc.context.register(annot);
      let annots = page.node.get(PDFName.of("Annots")) as PDFArray | undefined;
      if (!annots) {
        annots = doc.context.obj([]) as PDFArray;
        page.node.set(PDFName.of("Annots"), annots);
      }
      annots.push(annotRef);
    }
  }
  return await doc.save({ useObjectStreams: false });
}

/** Cache disque keyed par sha256(file_path + mtime_ms + quote). */
function cacheKeyFor(filePath: string, mtimeMs: number, quote: string): string {
  return createHash("sha256")
    .update(filePath)
    .update("\x00")
    .update(String(mtimeMs))
    .update("\x00")
    .update(quote)
    .digest("hex");
}

/** API publique. Retourne le PDF (Uint8Array) avec highlights injectés,
 *  ou l'original si aucun match. Cache automatique. */
export async function getHighlightedPdf(
  filePath: string,
  quote: string,
  cacheDir: string
): Promise<{ bytes: Uint8Array; matchCount: number; cached: boolean }> {
  const st = await stat(filePath);
  const key = cacheKeyFor(filePath, st.mtimeMs, quote);
  const cachePath = resolve(cacheDir, `${key}.pdf`);
  if (existsSync(cachePath)) {
    const bytes = new Uint8Array(await readFile(cachePath));
    return { bytes, matchCount: -1, cached: true };
  }
  const original = new Uint8Array(await readFile(filePath));
  // pdfjs-dist détache l'ArrayBuffer pendant getDocument. On doit faire 2
  // copies indépendantes (pdf-lib aussi détache parfois). `.slice()` copie
  // les bytes dans un nouveau buffer, contrairement à `new Uint8Array(view)`
  // qui réutilise le même buffer sous-jacent.
  const forPdfjs = original.slice();
  const forPdfLib = original.slice();
  const pages = await extractPages(forPdfjs);
  const matches = findMatches(pages, quote);
  if (matches.length === 0) {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, original);
    return { bytes: original, matchCount: 0, cached: false };
  }
  const highlighted = await injectHighlights(forPdfLib, matches);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, highlighted);
  return { bytes: highlighted, matchCount: matches.length, cached: false };
}
