#!/usr/bin/env node
// Génère les captures d'écran pour le guide d'utilisation OIF-Eval.
//
// Usage : node scripts/generate-screenshots.mjs
// Pré-requis : Next dev server sur http://localhost:3100, daemon Hono sur :7456,
// mode admin actif (PUT /api/app-config { isAdmin: true, currentUser: "Nicolas" }).
//
// Sortie : docs/screenshots/<nn>-<slug>.png (12 à 14 fichiers).

import { chromium } from "playwright";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const NEXT = "http://localhost:3100";
const DAEMON = "http://localhost:7456";

const VIEWPORT = { width: 1400, height: 900 };
const DPR = 2;
const COLOR = "#cc785c";

const ok = [];
const fail = [];

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function forceAdmin() {
  const r = await fetch(`${DAEMON}/api/app-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isAdmin: true, currentUser: "Nicolas" }),
  });
  if (!r.ok) throw new Error(`Impossible de forcer admin (HTTP ${r.status})`);
}

async function shot(page, file, opts = {}) {
  const out = path.join(OUT, file);
  await page.screenshot({
    path: out,
    fullPage: opts.fullPage ?? false,
    clip: opts.clip,
  });
  return out;
}

async function annotate(file, boxes) {
  // boxes = [{ x, y, w, h, label }]
  const inputPath = path.join(OUT, file);
  const buf = await fs.readFile(inputPath);
  const img = sharp(buf);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;

  // SVG overlay : encadrés rouges + étiquettes numérotées
  // Les boundingBox de Playwright sont en CSS pixels, alors que l'image
  // capturée est en pixels physiques (CSS px * DPR). On multiplie tout.
  const rects = boxes
    .map((b, i) => {
      const x = Math.max(0, Math.round(b.x * DPR));
      const y = Math.max(0, Math.round(b.y * DPR));
      const w = Math.round(b.w * DPR);
      const h = Math.round(b.h * DPR);
      const labelX = x + 16;
      const labelY = y - 18;
      const num = i + 1;
      const labelText = b.label ? `${num}. ${b.label}` : `${num}`;
      const labelLen = labelText.length;
      const labelBoxW = 22 + labelLen * 12;
      return `
        <rect x="${x}" y="${y}" width="${w}" height="${h}"
              fill="none" stroke="${COLOR}" stroke-width="6" rx="10" ry="10"/>
        <rect x="${labelX - 10}" y="${labelY - 22}" width="${labelBoxW}" height="32"
              fill="${COLOR}" rx="6" ry="6"/>
        <text x="${labelX}" y="${labelY}" fill="white"
              font-family="-apple-system, Helvetica, Arial, sans-serif"
              font-size="22" font-weight="600">${labelText}</text>
      `;
    })
    .join("\n");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      ${rects}
    </svg>
  `;
  await img
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .toFile(inputPath + ".tmp.png");
  await fs.rename(inputPath + ".tmp.png", inputPath);
}

async function safe(name, fn) {
  try {
    await fn();
    console.log(`OK  ${name}`);
    ok.push(name);
  } catch (e) {
    console.error(`KO  ${name} : ${e.message}`);
    fail.push({ name, error: e.message });
  }
}

async function waitFor(page, selector, timeout = 8000) {
  await page.waitForSelector(selector, { timeout });
}

async function clickIfExists(page, selector, timeout = 3000) {
  try {
    await page.waitForSelector(selector, { timeout });
    await page.click(selector);
    return true;
  } catch {
    return false;
  }
}

async function getBox(page, selector) {
  const el = await page.$(selector);
  if (!el) return null;
  return await el.boundingBox();
}

async function main() {
  await ensureDir(OUT);
  await forceAdmin();

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    locale: "fr-FR",
  });
  const page = await ctx.newPage();

  // Cache la barre de scroll macOS pour la propreté
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = `
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 3px; }
    `;
    document.documentElement.appendChild(style);
  });

  // -----------------------------------------------------------------
  // 01 - Accueil
  // -----------------------------------------------------------------
  await safe("01-accueil.png", async () => {
    await page.goto(`${NEXT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await shot(page, "01-accueil.png");
  });

  // -----------------------------------------------------------------
  // 02 - Évaluation, dossier non sélectionné
  // -----------------------------------------------------------------
  await safe("02-evaluation-vide.png", async () => {
    await page.goto(`${NEXT}/evaluation`, { waitUntil: "networkidle" });
    await waitFor(page, "text=Dossiers", 8000);
    await page.waitForTimeout(800);
    await shot(page, "02-evaluation-vide.png");
  });

  // -----------------------------------------------------------------
  // 03 - Évaluation, grille Joel-DOVONON
  // -----------------------------------------------------------------
  const dossierId = "Joel-DOVONON-8cc9e5baed";
  await safe("03-evaluation-grille.png", async () => {
    await page.goto(`${NEXT}/evaluation`, { waitUntil: "networkidle" });
    await waitFor(page, `button:has-text("${dossierId}")`, 8000);
    await page.click(`button:has-text("${dossierId}")`);
    // Attend la grille (badge IA non modifiées ou éligibilité)
    await page.waitForTimeout(1200);
    await waitFor(page, "text=Éligibilité", 8000);
    // Scroll la grille jusqu'à la section Notation pour rendre visibles
    // les badges 🤖 / 👤 / ✏️ et les questions IA cliquables.
    const notation = page.locator('text=/Notation .* questions/').first();
    if ((await notation.count()) > 0) {
      await notation.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
    }
    await shot(page, "03-evaluation-grille.png");
    // Annotations : bandeau résumé (pills 🤖 / 👤 / ✏️)
    const pillsLoc = page.locator('text=/IA non modifiées/').first();
    if ((await pillsLoc.count()) > 0) {
      const pillsBox = await pillsLoc.boundingBox();
      if (pillsBox) {
        await annotate("03-evaluation-grille.png", [
          {
            x: pillsBox.x - 6,
            y: pillsBox.y - 8,
            w: 460,
            h: pillsBox.height + 16,
            label: "Bandeau résumé : IA, humain, modifié",
          },
        ]);
      }
    }
  });

  // -----------------------------------------------------------------
  // 04 - Override modal (mini-form inline)
  // Cherche une question Q1 cliquable (bouton Modifier)
  // -----------------------------------------------------------------
  await safe("04-override-modal.png", async () => {
    // On reste sur la page Évaluation, dossier toujours sélectionné
    // Trouve le 1er bouton "Modifier" dans la grille (texte exact)
    const modifBtn = page.locator('button', { hasText: /^Modifier$/ }).first();
    const found = await modifBtn.count();
    if (found === 0) {
      await shot(page, "04-override-modal.png");
      throw new Error("Aucun bouton Modifier trouvé, capture brute");
    }
    await modifBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await modifBtn.click();
    await page.waitForTimeout(400);
    // Le mini-form inline s'ouvre dans la grille
    await waitFor(page, 'input[placeholder^="Raison du désaccord"]', 4000);
    await shot(page, "04-override-modal.png");
    // Annotations
    const raisonBox = await getBox(
      page,
      'input[placeholder^="Raison du désaccord"]'
    );
    if (raisonBox) {
      await annotate("04-override-modal.png", [
        {
          x: raisonBox.x - 6,
          y: raisonBox.y - 90,
          w: raisonBox.width + 12,
          h: 80,
          label: "Choix de la note humaine",
        },
        {
          x: raisonBox.x - 6,
          y: raisonBox.y - 6,
          w: raisonBox.width + 12,
          h: raisonBox.height + 12,
          label: "Raison obligatoire (3 caractères min)",
        },
      ]);
    }
    // Ferme le mini-form pour les captures suivantes
    await clickIfExists(page, 'button:has-text("Annuler")', 1500);
  });

  // -----------------------------------------------------------------
  // 05 - Vue Review humaine (en cliquant sur "à compléter ›")
  // -----------------------------------------------------------------
  await safe("05-review-form.png", async () => {
    // Cherche un texte "à compléter" cliquable (question hors-IA non encore reviewée)
    const acompleter = page.locator('text="à compléter ›"').first();
    const count = await acompleter.count();
    if (count === 0) {
      // Pas de question hors-IA cliquable : bascule manuellement via le segmented Review humaine
      const reviewBtn = page.locator('button:has-text("Review humaine")').first();
      if ((await reviewBtn.count()) > 0 && (await reviewBtn.isEnabled())) {
        await reviewBtn.click();
        await page.waitForTimeout(800);
        await shot(page, "05-review-form.png");
        return;
      }
      throw new Error("Aucune question hors-IA cliquable et bouton Review désactivé");
    }
    // La div parente est cliquable (role=button via cliquer sur le parent)
    await acompleter.click();
    await page.waitForTimeout(800);
    await shot(page, "05-review-form.png");
  });

  // -----------------------------------------------------------------
  // 06 - Chat drawer (Demander à Claude)
  // -----------------------------------------------------------------
  await safe("06-chat-drawer.png", async () => {
    // Re-navigue pour repartir sur la grille propre
    await page.goto(`${NEXT}/evaluation`, { waitUntil: "networkidle" });
    await waitFor(page, `button:has-text("${dossierId}")`, 8000);
    await page.click(`button:has-text("${dossierId}")`);
    await page.waitForTimeout(900);
    await waitFor(page, 'button:has-text("Demander à Claude")', 6000);
    await page.click('button:has-text("Demander à Claude")');
    await page.waitForTimeout(700);
    // Le drawer apparaît
    await shot(page, "06-chat-drawer.png");
  });

  // -----------------------------------------------------------------
  // 07 - Rule proposal form (Signaler un problème)
  // -----------------------------------------------------------------
  await safe("07-rule-form.png", async () => {
    // Ferme le drawer chat (clic sur croix s'il existe, sinon Escape)
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
    await waitFor(page, 'button:has-text("Signaler un problème")', 6000);
    await page.click('button:has-text("Signaler un problème")');
    await page.waitForTimeout(700);
    await waitFor(page, 'textarea[placeholder^="Sur ce dossier"]', 6000);
    await shot(page, "07-rule-form.png");
  });

  // -----------------------------------------------------------------
  // 08 - Liste propositions
  // -----------------------------------------------------------------
  await safe("08-propositions-list.png", async () => {
    await page.goto(`${NEXT}/propositions`, { waitUntil: "networkidle" });
    // Bascule filtre "Toutes" pour voir la liste complète
    await page.waitForTimeout(700);
    const select = page.locator('select').first();
    if ((await select.count()) > 0) {
      await select.selectOption("toutes");
      await page.waitForTimeout(500);
    }
    await shot(page, "08-propositions-list.png");
  });

  // -----------------------------------------------------------------
  // 09 - Diff modal
  // -----------------------------------------------------------------
  await safe("09-propositions-diff.png", async () => {
    // S'assure d'être sur /propositions avec filtre toutes
    await page.goto(`${NEXT}/propositions`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const select = page.locator('select').first();
    if ((await select.count()) > 0) {
      await select.selectOption("toutes");
      await page.waitForTimeout(500);
    }
    // Clique sur le 1er "Voir le diff"
    const btn = page.locator('button:has-text("Voir le diff")').first();
    await btn.waitFor({ timeout: 6000 });
    await btn.click();
    // Attend modal + diff loaded
    await waitFor(page, 'text=Diff de la proposition', 6000);
    // Attend le toggle Côte à côte / Unifié
    await page.waitForTimeout(1500);
    await shot(page, "09-propositions-diff.png");
    // Annotation sur le toggle Côte à côte / Unifié
    // Le DiffViewer rend deux boutons côte à côte ; on encadre les deux.
    const cote = page.locator('button', { hasText: /^Côte à côte$/ }).first();
    const unif = page.locator('button', { hasText: /^Unifié$/ }).first();
    if ((await cote.count()) > 0 && (await unif.count()) > 0) {
      const a = await cote.boundingBox();
      const b = await unif.boundingBox();
      if (a && b) {
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const right = Math.max(a.x + a.width, b.x + b.width);
        const bottom = Math.max(a.y + a.height, b.y + b.height);
        await annotate("09-propositions-diff.png", [
          {
            x: x - 6,
            y: y - 6,
            w: right - x + 12,
            h: bottom - y + 12,
            label: "Bascule Côte à côte / Unifié",
          },
        ]);
      }
    }
    // Ferme le modal
    await page.keyboard.press("Escape").catch(() => {});
  });

  // -----------------------------------------------------------------
  // 10 - Paramètres : haut (sticky avec Claude + Nouvelle campagne)
  // -----------------------------------------------------------------
  await safe("10-parametres-overview.png", async () => {
    await page.goto(`${NEXT}/parametres`, { waitUntil: "networkidle" });
    await waitFor(page, "text=Paramètres", 8000);
    await page.waitForTimeout(800);
    // Capture le viewport entier (le bandeau est en haut)
    await shot(page, "10-parametres-overview.png");
  });

  // -----------------------------------------------------------------
  // 11 - Section Campagnes
  // -----------------------------------------------------------------
  await safe("11-campagnes.png", async () => {
    // Reste sur /parametres, scroll jusqu'à la section Campagnes
    const sectionTitle = page.locator('text="Campagnes"').first();
    await sectionTitle.waitFor({ timeout: 6000 });
    await sectionTitle.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, "11-campagnes.png");
  });

  // -----------------------------------------------------------------
  // 12 - Section Rapport de calibrage (liste)
  // -----------------------------------------------------------------
  await safe("12-calibrage-list.png", async () => {
    const sectionTitle = page.locator('text="Rapport de calibrage"').first();
    await sectionTitle.waitFor({ timeout: 6000 });
    await sectionTitle.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, "12-calibrage-list.png");
  });

  // -----------------------------------------------------------------
  // 13 - Modal calibrage (rapport le plus récent)
  // -----------------------------------------------------------------
  await safe("13-calibrage-modal.png", async () => {
    // Re-scroll vers la section Rapport de calibrage
    const sectionTitle = page.locator('text="Rapport de calibrage"').first();
    await sectionTitle.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    // Les items rapport sont des <button> avec une date formatée (jj/mm/yyyy hh:mm).
    // On clique sur le 1er bouton qui contient un texte de type "% accord".
    const reportBtn = page
      .locator('button', { hasText: /% accord/ })
      .first();
    await reportBtn.waitFor({ timeout: 6000 });
    await reportBtn.click();
    // Attend le modal (boutons / titres typiques du modal calibrage)
    await page.waitForTimeout(1500);
    await shot(page, "13-calibrage-modal.png");
    // Annotation sur le bouton "⚡ Générer 5 propositions"
    const genBtn = page
      .locator('button', { hasText: /Générer 5 propositions/ })
      .first();
    if ((await genBtn.count()) > 0) {
      const box = await genBtn.boundingBox();
      if (box) {
        await annotate("13-calibrage-modal.png", [
          {
            x: box.x - 6,
            y: box.y - 6,
            w: box.width + 12,
            h: box.height + 12,
            label: "Demande à Claude de proposer des règles",
          },
        ]);
      }
    }
    // Ferme le modal
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  });

  // -----------------------------------------------------------------
  // 14 - Logs RGPD
  // -----------------------------------------------------------------
  await safe("14-logs-rgpd.png", async () => {
    await page.goto(`${NEXT}/logs`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await shot(page, "14-logs-rgpd.png");
  });

  await browser.close();

  console.log("\n=== Bilan ===");
  console.log(`Réussies : ${ok.length}`);
  console.log(`Échouées  : ${fail.length}`);
  if (fail.length > 0) {
    for (const f of fail) console.log(`  - ${f.name} : ${f.error}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
