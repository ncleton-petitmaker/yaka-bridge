import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const flagSvg = readFileSync('/Users/nicolascleton/Documents/OIF/oif-eval/public/francophonie-flag.svg');
const PUBLIC = '/Users/nicolascleton/Documents/OIF/oif-eval/public';

async function makeIcon(size) {
  // Coin radius macOS Big Sur+ : ~22.5% de la taille
  const radius = Math.round(size * 0.225);
  // Padding interne pour aérer le contenu (~9% de chaque côté)
  const inset = Math.round(size * 0.09);
  const flagW = size - 2 * inset;
  const flagH = Math.round(flagW * 600 / 900); // ratio drapeau 3:2

  // Render le drapeau à la taille interne
  const flagBuf = await sharp(flagSvg, { density: 600 })
    .resize({ width: flagW, height: flagH, fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();

  // Squircle SVG : rect à coins arrondis avec gradient subtle
  const bgSvg = `
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#f5f4ee"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#bg)"/>
  <rect width="${size - 2}" height="${size - 2}" x="1" y="1" rx="${radius - 1}" ry="${radius - 1}"
        fill="none" stroke="#ebe8e1" stroke-width="2"/>
</svg>`;

  const bg = await sharp(Buffer.from(bgSvg)).png().toBuffer();

  // Composition : background squircle + drapeau centré verticalement+horizontalement
  await sharp(bg)
    .composite([{ input: flagBuf, top: Math.round((size - flagH) / 2), left: inset }])
    .png()
    .toFile(`${PUBLIC}/icon-${size}.png`);

  console.log(`icon-${size}.png OK`);
}

for (const s of [1024, 512, 256, 128, 64, 32, 16]) {
  await makeIcon(s);
}
