/**
 * Inbox de fichiers joints au chat (référentiels, docs, etc.).
 *
 * Stocke chaque upload sous `data/.claude/inbox/<timestamp>-<safe-filename>`
 * et, si c'est un .docx, génère aussi une version .md convertie via mammoth
 * pour que Claude puisse facilement la lire avec le tool Read.
 *
 * Utilisé surtout pour les référentiels de critères (Questionnaire FAE x.docx)
 * que l'admin joint au chat pour régénérer automatiquement les skills.
 */
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import mammoth from "mammoth";

export function inboxDir(dataDir: string): string {
  return resolve(dataDir, ".claude", "inbox");
}

function safeName(filename: string): string {
  return filename
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export interface InboxUploadResult {
  originalPath: string;
  textPath: string | null;
  textPreview: string | null;
  size: number;
  ext: string;
  filename: string;
  conversionWarnings: string[];
}

/**
 * Stocke un upload (Buffer) et tente une conversion en .md/.txt si pertinent.
 * Pour .docx → .md via mammoth.
 * Pour .md, .txt → on copie tel quel et on pointe textPath = originalPath.
 * Pour le reste (.pdf, .xlsx, ...) → on stocke seulement, Claude se débrouillera
 * via Bash + outils système si besoin.
 */
export async function storeUpload(
  dataDir: string,
  filename: string,
  buffer: Buffer
): Promise<InboxUploadResult> {
  const dir = inboxDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const safe = safeName(filename) || "file";
  const originalPath = resolve(dir, `${ts}-${safe}`);
  writeFileSync(originalPath, buffer);

  const ext = extname(filename).toLowerCase();
  const warnings: string[] = [];
  let textPath: string | null = null;
  let textPreview: string | null = null;

  if (ext === ".md" || ext === ".txt") {
    textPath = originalPath;
    try {
      textPreview = buffer.toString("utf8").slice(0, 800);
    } catch {
      // pas grave
    }
  } else if (ext === ".docx") {
    try {
      // convertToMarkdown existe à l'exécution mais pas dans les types
      const m = mammoth as unknown as {
        convertToMarkdown: (input: { buffer: Buffer }) => Promise<{
          value: string;
          messages: { message: string }[];
        }>;
      };
      const result = await m.convertToMarkdown({ buffer });
      const md = result.value || "";
      const baseSafe = safe.replace(/\.docx$/i, "");
      const mdPath = resolve(dir, `${ts}-${baseSafe}.md`);
      writeFileSync(mdPath, md, "utf8");
      textPath = mdPath;
      textPreview = md.slice(0, 800);
      for (const m of result.messages ?? []) {
        warnings.push(`mammoth: ${m.message}`);
      }
    } catch (err) {
      warnings.push(`Conversion docx échouée : ${(err as Error).message}`);
    }
  } else if (ext === ".doc") {
    warnings.push(
      "Format .doc (Word ancien) non supporté nativement. Réenregistrer en .docx ou .pdf."
    );
  } else if (ext === ".pdf") {
    warnings.push(
      "Fichier PDF stocké tel quel. Claude pourra utiliser Read sur ce PDF dans le run."
    );
  } else if (ext === ".xlsx" || ext === ".xls") {
    warnings.push(
      "Fichier tableur stocké tel quel. Claude pourra utiliser Bash pour extraire le contenu si nécessaire."
    );
  }

  return {
    originalPath,
    textPath,
    textPreview,
    size: statSync(originalPath).size,
    ext,
    filename: safe,
    conversionWarnings: warnings,
  };
}
