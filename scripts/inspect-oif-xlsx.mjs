#!/usr/bin/env node
import ExcelJS from "exceljs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node inspect-oif-xlsx.mjs <fichier.xlsx>");
  process.exit(1);
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(path);

console.log(`=== ${path} ===`);
console.log(`Feuilles: ${wb.worksheets.length}`);
for (const ws of wb.worksheets) {
  console.log(`\n>>> "${ws.name}" (${ws.rowCount} rows × ${ws.columnCount} cols)`);
  // Header row
  const header = ws.getRow(1);
  const cols = [];
  header.eachCell({ includeEmpty: false }, (cell, col) => {
    cols.push(`[${col}] ${String(cell.value ?? "").replaceAll("\n", " | ").slice(0, 80)}`);
  });
  console.log("HEADER:");
  cols.forEach((c) => console.log("  " + c));
  // Premier exemple de données
  if (ws.rowCount >= 2) {
    console.log("\nEXEMPLE ROW 2:");
    const r = ws.getRow(2);
    r.eachCell({ includeEmpty: false }, (cell, col) => {
      const v = cell.value;
      const txt = typeof v === "object" && v !== null && "text" in v ? v.text : String(v ?? "");
      console.log(`  [${col}] ${txt.replaceAll("\n", " | ").slice(0, 80)}`);
    });
  }
}
