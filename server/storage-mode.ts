/**
 * Détection du type de stockage sous-jacent à un chemin "qui ressemble à un dossier local".
 *
 * Les évaluateurs OIF peuvent pointer leur dossier partagé vers :
 *   - OneDrive Business (cas le plus probable, OIF est sur M365)
 *   - SharePoint Online (variante avec FileProvider macOS)
 *   - Dropbox / Dropbox Business
 *   - Google Drive Desktop
 *   - iCloud Drive
 *   - Un partage SMB / NAS classique
 *   - Un dossier purement local (mode autonome ou erreur de config)
 *
 * Du point de vue de Node, c'est toujours un chemin local, mais le comportement
 * de sync change radicalement selon le type. On expose le type pour adapter
 * l'UX (onboarding, badges, warnings) sans changer la logique métier.
 */
import { existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { homedir, platform } from "node:os";

export type StorageType =
  | "onedrive"
  | "sharepoint"
  | "dropbox"
  | "google-drive"
  | "icloud"
  | "smb"
  | "local";

export interface StorageDetection {
  type: StorageType;
  label: string;
  /** Nom du tenant / compte si extractible (ex. "OIF" pour OneDrive-OIF) */
  tenant?: string;
  /** Avertissements non bloquants à afficher à l'utilisateur */
  warnings: string[];
  /** True si on est sûr du type, false si c'est une heuristique faible */
  confident: boolean;
}

export interface SyncHealth {
  /** Le sync engine est-il en train de tourner sur cette machine ? */
  processRunning: boolean;
  /** Nom du process recherché (pour debug UI) */
  processName: string;
  /** Si null, pas de check possible (ex. mode local) */
  available: "yes" | "no" | "unknown" | "not-applicable";
}

/**
 * Normalise un chemin pour comparaisons : résolu absolu, slashes uniformes.
 */
function norm(p: string): string {
  return resolve(p).replaceAll("\\", "/");
}

/**
 * Détecte le type de dossier à partir du chemin.
 *
 * Patterns connus (documentés Microsoft, Dropbox, Google) :
 *   macOS modern : ~/Library/CloudStorage/<Provider>-<Tenant>/...
 *   macOS legacy : ~/OneDrive, ~/Dropbox, ~/Google Drive, ~/iCloud Drive
 *   Windows      : %USERPROFILE%\OneDrive, OneDrive - <Tenant>, etc.
 *   SMB          : /Volumes/<vol> (Mac), \\server\share (Windows UNC)
 */
export function detectStorageType(pathInput: string): StorageDetection {
  const p = norm(pathInput);
  const home = norm(homedir());
  const lower = p.toLowerCase();
  const isMac = platform() === "darwin";
  const isWin = platform() === "win32";

  // macOS modern : ~/Library/CloudStorage/<Provider>-<Tenant>
  if (p.startsWith(home + "/Library/CloudStorage/")) {
    const sub = p.slice((home + "/Library/CloudStorage/").length).split("/")[0];
    if (sub.startsWith("OneDrive-")) {
      return {
        type: "onedrive",
        label: "OneDrive Business",
        tenant: sub.slice("OneDrive-".length),
        warnings: [],
        confident: true,
      };
    }
    if (sub.startsWith("OneDrive")) {
      return {
        type: "onedrive",
        label: "OneDrive personnel",
        warnings: ["Usage personnel détecté. Pour OIF, prévoir OneDrive Business."],
        confident: true,
      };
    }
    if (sub.startsWith("SharePoint-")) {
      return {
        type: "sharepoint",
        label: "SharePoint Online",
        tenant: sub.slice("SharePoint-".length),
        warnings: [],
        confident: true,
      };
    }
    if (sub.startsWith("Dropbox")) {
      return {
        type: "dropbox",
        label: "Dropbox",
        warnings: [],
        confident: true,
      };
    }
    if (sub.startsWith("GoogleDrive-")) {
      return {
        type: "google-drive",
        label: "Google Drive",
        tenant: sub.slice("GoogleDrive-".length),
        warnings: [
          "Google Drive est rare dans le secteur diplomatique francophone (souveraineté).",
        ],
        confident: true,
      };
    }
    if (sub.startsWith("iCloud")) {
      return {
        type: "icloud",
        label: "iCloud Drive",
        warnings: ["iCloud Drive n'est pas un outil pro, à éviter pour OIF."],
        confident: true,
      };
    }
  }

  // macOS legacy / iCloud direct
  if (
    p === home + "/iCloud Drive" ||
    p.startsWith(home + "/iCloud Drive/") ||
    p.startsWith(home + "/Library/Mobile Documents/com~apple~CloudDocs")
  ) {
    return {
      type: "icloud",
      label: "iCloud Drive",
      warnings: ["iCloud Drive n'est pas un outil pro, à éviter pour OIF."],
      confident: true,
    };
  }

  // Windows / macOS legacy : OneDrive
  if (
    /[\\/]onedrive(\s-\s[^\\/]+)?([\\/]|$)/i.test(p) ||
    /[\\/]onedrive([\\/]|$)/i.test(p)
  ) {
    const m = p.match(/[\\/]OneDrive(?:\s-\s([^\\/]+))?(?=[\\/]|$)/i);
    return {
      type: "onedrive",
      label: m?.[1] ? "OneDrive Business" : "OneDrive",
      tenant: m?.[1],
      warnings: [],
      confident: true,
    };
  }

  // Dropbox legacy
  if (lower.includes("/dropbox/") || lower.endsWith("/dropbox")) {
    return {
      type: "dropbox",
      label: "Dropbox",
      warnings: [],
      confident: true,
    };
  }

  // Google Drive legacy / mount G:\ Windows
  if (
    /[\\/]google\s?drive([\\/]|$)/i.test(p) ||
    (isWin && /^[A-Z]:[\\/]My Drive/i.test(pathInput))
  ) {
    return {
      type: "google-drive",
      label: "Google Drive",
      warnings: [
        "Google Drive est rare dans le secteur diplomatique francophone (souveraineté).",
      ],
      confident: true,
    };
  }

  // Windows UNC SMB
  if (isWin && pathInput.startsWith("\\\\")) {
    return {
      type: "smb",
      label: "Partage réseau (SMB)",
      warnings: [
        "Vérifier que le partage est monté en permanence et que le chemin reste stable au redémarrage.",
      ],
      confident: true,
    };
  }

  // macOS volume monté
  if (isMac && p.startsWith("/Volumes/") && p !== "/Volumes") {
    const volName = p.slice("/Volumes/".length).split("/")[0];
    const isNetwork = checkMacVolumeIsNetwork(volName);
    if (isNetwork) {
      return {
        type: "smb",
        label: `Partage réseau (${volName})`,
        warnings: [
          "Vérifier que le partage est monté en permanence et que le chemin reste stable au redémarrage.",
        ],
        confident: true,
      };
    }
  }

  // Sinon : local
  return {
    type: "local",
    label: "Dossier local",
    warnings: existsSync(p)
      ? [
          "Ce dossier ne semble pas synchronisé. Vos collègues ne verront pas son contenu sauf via import/export manuel.",
        ]
      : ["Ce dossier n'existe pas encore."],
    confident: true,
  };
}

/**
 * Sur macOS, vérifie si un volume monté dans /Volumes/ est un partage réseau.
 * Heuristique via la commande `mount` (sortie : type smbfs, afpfs, nfs).
 */
function checkMacVolumeIsNetwork(volName: string): boolean {
  try {
    const out = execSync("mount", {
      encoding: "utf8",
      timeout: 1500,
    });
    const lines = out.split("\n");
    for (const line of lines) {
      if (line.includes(`/Volumes/${volName} `)) {
        return /\((smbfs|afpfs|nfs|webdav)/.test(line);
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Vérifie si le sync engine correspondant à ce type de stockage tourne sur la machine.
 * Renvoie "not-applicable" pour les types qui n'ont pas de sync engine (smb, local).
 */
export function checkSyncHealth(type: StorageType): SyncHealth {
  if (type === "local" || type === "smb") {
    return {
      processRunning: true,
      processName: "—",
      available: "not-applicable",
    };
  }

  const isMac = platform() === "darwin";
  const isWin = platform() === "win32";

  // Mapping type → noms de process à chercher
  const processQueries: Record<
    Exclude<StorageType, "local" | "smb">,
    { mac: string[]; win: string[]; label: string }
  > = {
    onedrive: {
      mac: ["OneDrive"],
      win: ["OneDrive.exe"],
      label: "OneDrive",
    },
    sharepoint: {
      mac: ["OneDrive"],
      win: ["OneDrive.exe"],
      label: "OneDrive (SharePoint)",
    },
    dropbox: {
      mac: ["Dropbox"],
      win: ["Dropbox.exe"],
      label: "Dropbox",
    },
    "google-drive": {
      mac: ["Google Drive"],
      win: ["GoogleDriveFS.exe"],
      label: "Google Drive",
    },
    icloud: {
      mac: ["bird", "cloudd"],
      win: ["iCloudDrive.exe"],
      label: "iCloud",
    },
  };

  const q = processQueries[type as Exclude<StorageType, "local" | "smb">];
  const candidates = isMac ? q.mac : isWin ? q.win : [];
  if (candidates.length === 0) {
    return {
      processRunning: false,
      processName: q.label,
      available: "unknown",
    };
  }

  for (const name of candidates) {
    if (isProcessRunning(name)) {
      return {
        processRunning: true,
        processName: q.label,
        available: "yes",
      };
    }
  }
  return {
    processRunning: false,
    processName: q.label,
    available: "no",
  };
}

function isProcessRunning(name: string): boolean {
  try {
    if (platform() === "win32") {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, {
        encoding: "utf8",
        timeout: 1500,
      });
      return out.toLowerCase().includes(name.toLowerCase());
    } else {
      execSync(`pgrep -f ${JSON.stringify(name)}`, { timeout: 1500 });
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Détecte les "conflict copies" laissées par les sync engines dans un dossier.
 * Patterns connus :
 *   - OneDrive : "fichier-NicolasMacBook" (pas standardisé, regex large)
 *   - Dropbox  : "fichier (Alice's conflicted copy 2026-05-09)"
 *   - SyncThing: "fichier.sync-conflict-20260509-..."
 *   - Generic  : tout fichier avec "conflict" ou "(conflicted" dans son nom
 */
const CONFLICT_PATTERNS: RegExp[] = [
  /\(.*conflicted copy.*\)/i, // Dropbox
  /\(conflict.*\)/i, // Generic
  /\.sync-conflict-/i, // SyncThing / Resilio
  /-conflict-\d/i, // Generic
  /\(another's copy\)/i,
];

export interface ConflictFile {
  path: string;
  size: number;
  mtime: string;
}

export function findConflictCopies(rootDir: string): ConflictFile[] {
  if (!existsSync(rootDir)) return [];
  const results: ConflictFile[] = [];
  walk(rootDir, results, 0);
  return results;
}

function walk(dir: string, out: ConflictFile[], depth: number): void {
  if (depth > 6) return; // Garde-fou
  try {
    const entries = readdirSafe(dir);
    for (const name of entries) {
      const full = dir + "/" + name;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name.startsWith(".")) continue;
        walk(full, out, depth + 1);
      } else if (st.isFile()) {
        if (CONFLICT_PATTERNS.some((re) => re.test(name))) {
          out.push({
            path: full,
            size: st.size,
            mtime: st.mtime.toISOString(),
          });
        }
      }
    }
  } catch {
    /* ignore unreadable dirs */
  }
}

function readdirSafe(dir: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Helper pour `sep` cross-platform sans import */
export const PATH_SEP = sep;
