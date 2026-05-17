#!/usr/bin/env node
/**
 * Capture les nouvelles screenshots ajoutées avec le mode partagé / manuel et
 * l'onglet Dashboard. Ne touche pas aux 14 screenshots historiques.
 *
 * Usage : npm run dev (en parallèle), puis : node scripts/capture-new-screenshots.mjs
 *
 * Sortie :
 *   docs/screenshots/15-dashboard.png
 *   docs/screenshots/16-parametres-tabs.png
 *   docs/screenshots/17-stockage-mode-selector.png
 *   docs/screenshots/18-stockage-manuel.png
 *   docs/screenshots/19-reglage-claude.png
 */
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const NEXT = "http://localhost:3100";
const DAEMON = "http://localhost:7456";

const VIEWPORT = { width: 1400, height: 900 };

async function forceAdmin() {
  const r = await fetch(`${DAEMON}/api/app-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isAdmin: true, currentUser: "Nicolas (test)" }),
  });
  if (!r.ok) throw new Error(`forceAdmin HTTP ${r.status}`);
}

async function setStorageMode(mode) {
  const r = await fetch(`${DAEMON}/api/app-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storageMode: mode }),
  });
  if (!r.ok) throw new Error(`setStorageMode HTTP ${r.status}`);
}

async function shot(page, name, opts = {}) {
  const out = path.join(OUT, name);
  await page.screenshot({
    path: out,
    fullPage: opts.fullPage ?? false,
    clip: opts.clip,
  });
  console.log(`  → ${name}`);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await forceAdmin();

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    locale: "fr-FR",
  });
  const page = await ctx.newPage();

  // ============================================================
  // 15 - Dashboard admin (vue avec opérateurs, sans clic)
  // ============================================================
  console.log("15-dashboard.png");
  await page.goto(`${NEXT}/dashboard`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Avancement global", { timeout: 8000 });
  await page.waitForTimeout(800);
  await shot(page, "15-dashboard.png");

  // ============================================================
  // 15b - Dashboard avec un opérateur cliqué (panneau détail)
  // ============================================================
  console.log("15b-dashboard-detail.png");
  // Clique sur la 1re carte d'évaluateur
  const card = page.locator("button", { hasText: /^Alice|^Bob|^Camille|^Diane|^Elsa|^Fanny|^Nicolas/ }).first();
  if ((await card.count()) > 0) {
    await card.click();
    await page.waitForTimeout(700);
    await shot(page, "15b-dashboard-detail.png", { fullPage: true });
  }

  // ============================================================
  // 16 - Paramètres : nouveau système d'onglets (tab Profil)
  // ============================================================
  console.log("16-parametres-tabs.png");
  // Reset storage mode shared pour la capture
  await setStorageMode("shared");
  await page.goto(`${NEXT}/parametres`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Paramètres", { timeout: 8000 });
  await page.waitForTimeout(700);
  await shot(page, "16-parametres-tabs.png");

  // ============================================================
  // 17 - Stockage mode partagé (sélecteur + détection)
  // ============================================================
  console.log("17-stockage-mode-selector.png");
  // Clique sur l'onglet Stockage
  await page.click('button:has-text("Stockage")');
  await page.waitForSelector("text=Mode de partage", { timeout: 5000 });
  await page.waitForTimeout(700);
  await shot(page, "17-stockage-mode-selector.png");

  // ============================================================
  // 18 - Stockage mode manuel (panneau import/export)
  // ============================================================
  console.log("18-stockage-manuel.png");
  await page.click('button:has-text("Import / Export manuel")');
  await page.waitForSelector("text=Mode autonome", { timeout: 5000 });
  await page.waitForTimeout(700);
  await shot(page, "18-stockage-manuel.png");

  // Reset shared mode
  await setStorageMode("shared");

  // ============================================================
  // 19 - Réglage Claude (modèle + diagnostic)
  // ============================================================
  console.log("19-reglage-claude.png");
  await page.goto(`${NEXT}/parametres`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.click('button:has-text("Réglage Claude")');
  await page.waitForSelector("text=Modèle Claude", { timeout: 5000 });
  await page.waitForTimeout(700);
  await shot(page, "19-reglage-claude.png");

  await browser.close();
  console.log("\n✓ Captures terminées dans docs/screenshots/");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
