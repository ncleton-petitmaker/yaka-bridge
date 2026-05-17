/**
 * Hook afterPack appelé par electron-builder une fois l'arborescence
 * unpacked produite. On copie .next/standalone/.next/static qui est
 * mystérieusement exclu par electron-builder (peut-être un filtre par
 * défaut sur les dossiers contenant un '.' à plusieurs niveaux).
 *
 * Sans ça, Next standalone démarre mais sert le HTML sans CSS ni JS
 * (les <link> et <script> renvoient 404).
 */
const fs = require("node:fs");
const path = require("node:path");

function copyRecursive(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, dst, { recursive: true });
  return true;
}

exports.default = async function afterPack(context) {
  const projectRoot = context.packager.projectDir;
  const appOut = context.appOutDir;
  const isWin = context.electronPlatformName === "win32";

  // Avec asar: true, les fichiers en asarUnpack vont dans resources/app.asar.unpacked/
  // Avec asar: false, ils sont à resources/app/
  // On détecte le bon path en cherchant lequel existe.
  const baseDir = isWin
    ? path.join(appOut, "resources")
    : path.join(appOut, "Contents", "Resources");

  let resourcesDir;
  if (fs.existsSync(path.join(baseDir, "app.asar.unpacked"))) {
    resourcesDir = path.join(baseDir, "app.asar.unpacked");
  } else if (fs.existsSync(path.join(baseDir, "app"))) {
    resourcesDir = path.join(baseDir, "app");
  } else {
    console.error(`[afterPack] resources dir introuvable dans ${baseDir}`);
    return;
  }
  console.log(`[afterPack] target resourcesDir : ${resourcesDir}`);

  const targets = [
    {
      src: path.join(projectRoot, ".next", "static"),
      dst: path.join(resourcesDir, ".next", "standalone", ".next", "static"),
      label: ".next/static → standalone/.next/static",
    },
    {
      src: path.join(projectRoot, "public"),
      dst: path.join(resourcesDir, ".next", "standalone", "public"),
      label: "public → standalone/public",
    },
  ];

  for (const t of targets) {
    if (!fs.existsSync(t.src)) {
      console.log(`[afterPack] skip ${t.label} (source absente)`);
      continue;
    }
    if (fs.existsSync(t.dst)) {
      console.log(`[afterPack] skip ${t.label} (destination déjà copiée)`);
      continue;
    }
    copyRecursive(t.src, t.dst);
    console.log(`[afterPack] ✓ ${t.label}`);
  }
};
