#!/usr/bin/env node
/**
 * MCP server stdio qui expose une tool `read_xlsx` à Claude Code.
 *
 * Pourquoi : Claude Code ne sait pas lire les fichiers .xlsx binaires
 * nativement. Sur Mac, on contournait avec Bash + python3 + openpyxl, mais
 * Python n'est pas garanti sur Windows chez les clients. Cette tool utilise
 * ExcelJS (déjà bundlé) côté Node et marche identiquement Mac/Windows sans
 * dépendance externe.
 *
 * Protocole MCP : JSON-RPC sur stdin/stdout. Géré par @modelcontextprotocol/sdk.
 *
 * Sécurité : le path est validé contre la même whitelist que les hooks
 * (lecture de app-config.json pour récupérer les dossiers autorisés).
 */
const path = require("node:path");
const fs = require("node:fs");

async function main() {
  // Imports dynamiques (le SDK MCP est ESM, requires async loader en CJS).
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
  } = await import("@modelcontextprotocol/sdk/types.js");
  const ExcelJS = require("exceljs");
  const mammoth = require("mammoth");

  // Charge la whitelist depuis app-config.json (même mécanisme que le hook
  // restrict-write-paths.mjs). Empêche un appel `read_xlsx` sur /etc/passwd.
  function loadAllowedDirs() {
    const dataDir = process.env.FAE_DATA_DIR || process.cwd();
    const cfgPath = path.resolve(dataDir, ".claude", "app-config.json");
    const dirs = new Set();
    dirs.add(path.resolve(dataDir));
    try {
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        if (cfg.sharedSkillsDir) dirs.add(path.resolve(cfg.sharedSkillsDir));
        if (cfg.auditLogDir) dirs.add(path.resolve(cfg.auditLogDir));
        if (cfg.outputDir) dirs.add(path.resolve(cfg.outputDir));
        if (cfg.inputDir) dirs.add(path.resolve(cfg.inputDir));
      }
    } catch {
      /* ignore */
    }
    return Array.from(dirs);
  }

  function isPathAllowed(filePath, allowedDirs) {
    if (!path.isAbsolute(filePath)) return false;
    let resolved = path.resolve(filePath);
    try {
      if (fs.existsSync(resolved)) resolved = fs.realpathSync(resolved);
    } catch {
      /* path n'existe pas */
    }
    return allowedDirs.some((dir) => {
      const dirResolved = path.resolve(dir);
      return (
        resolved === dirResolved ||
        resolved.startsWith(dirResolved + path.sep)
      );
    });
  }

  /** Convertit une cellule ExcelJS en string lisible. */
  function cellToString(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
      if ("result" in v) return String(v.result ?? "");
      if ("richText" in v) return v.richText.map((r) => r.text).join("");
      if (v instanceof Date) return v.toISOString().slice(0, 10);
    }
    return String(v);
  }

  /** Lit un .xlsx et retourne tout son contenu en texte tabulé. */
  async function readXlsx(filePath) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const lines = [];
    wb.eachSheet((sheet) => {
      lines.push(`=== Feuille : ${sheet.name} ===`);
      sheet.eachRow((row) => {
        const values = (row.values || []).slice(1).map(cellToString);
        const line = values.join("\t").replace(/\t+$/, "");
        if (line.trim()) lines.push(line);
      });
      lines.push("");
    });
    return lines.join("\n");
  }

  /** Lit un .docx et retourne son contenu en texte brut (mammoth). */
  async function readDocx(filePath) {
    const result = await mammoth.extractRawText({ path: filePath });
    let text = result.value || "";
    if (result.messages && result.messages.length > 0) {
      const warnings = result.messages
        .filter((m) => m.type === "warning" || m.type === "error")
        .map((m) => m.message)
        .slice(0, 5);
      if (warnings.length > 0) {
        text += "\n\n[Avertissements parse docx : " + warnings.join("; ") + "]";
      }
    }
    return text;
  }

  const server = new Server(
    { name: "oif-eval-xlsx", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "read_xlsx",
        description:
          "Lit un fichier Excel (.xlsx) et retourne son contenu sous forme de texte tabulé (TSV). Utilise cette tool au lieu de Read pour tous les fichiers .xlsx (Read ne sait pas parser les binaires Excel). Toutes les feuilles sont incluses, séparées par '=== Feuille : <nom> ==='. Une cellule par colonne, séparées par tabulations.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Chemin absolu du fichier .xlsx à lire",
            },
          },
          required: ["file_path"],
        },
      },
      {
        name: "read_docx",
        description:
          "Lit un fichier Word (.docx) et retourne son contenu en texte brut. Utilise cette tool au lieu de Read pour tous les fichiers .docx (Read ne sait pas parser les binaires Word - il retourne du ZIP illisible). Le texte est extrait avec mammoth, structure (titres, listes) aplatie en paragraphes.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Chemin absolu du fichier .docx à lire",
            },
          },
          required: ["file_path"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    if (toolName !== "read_xlsx" && toolName !== "read_docx") {
      throw new Error(`Tool inconnue : ${toolName}`);
    }
    const filePath = req.params.arguments?.file_path;
    if (!filePath || typeof filePath !== "string") {
      throw new Error("file_path manquant ou invalide");
    }
    const allowed = loadAllowedDirs();
    if (!isPathAllowed(filePath, allowed)) {
      return {
        content: [
          {
            type: "text",
            text:
              `Lecture refusée : le chemin ${filePath} est en dehors des ` +
              `dossiers autorisés (${allowed.join(", ")}).`,
          },
        ],
        isError: true,
      };
    }
    if (!fs.existsSync(filePath)) {
      return {
        content: [{ type: "text", text: `Fichier introuvable : ${filePath}` }],
        isError: true,
      };
    }
    try {
      const content =
        toolName === "read_xlsx"
          ? await readXlsx(filePath)
          : await readDocx(filePath);
      return { content: [{ type: "text", text: content }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Erreur lecture ${toolName === "read_xlsx" ? "xlsx" : "docx"} : ${err?.message || err}`,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP xlsx server fatal:", err?.stack || err);
  process.exit(1);
});
