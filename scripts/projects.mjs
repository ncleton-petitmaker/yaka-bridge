#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS_DIR = resolve(ROOT, process.env.YAKA_PROJECTS_DIR ?? "Projets");
const command = process.argv[2] ?? "list";
const args = parseArgs(process.argv.slice(3));

if (command === "list") {
  listProjects();
} else if (command === "check") {
  checkProjects();
} else if (command === "init") {
  initCompany();
} else {
  console.error(`Unknown projects command: ${command}`);
  console.error("Usage: node scripts/projects.mjs [list|check|init]");
  process.exit(1);
}

function listProjects() {
  ensureProjectsDir();
  const companies = companyFolders();
  if (companies.length === 0) {
    console.log("No local customer folders found in Projets/.");
    return;
  }

  for (const company of companies) {
    console.log(`\n${company.name}`);
    for (const project of company.projects) {
      const markers = [];
      if (project.hasGit) markers.push("git");
      if (project.hasPackageJson) markers.push("node");
      if (project.hasDockerCompose) markers.push("compose");
      if (project.hasReadme) markers.push("readme");
      console.log(`  - ${project.name}${markers.length ? ` [${markers.join(", ")}]` : ""}`);
    }
    if (company.projects.length === 0) console.log("  - empty");
  }
}

function checkProjects() {
  ensureProjectsDir();
  const failures = [];

  assertGitIgnore("Projets/private-company/.env.local", true, failures);
  assertGitIgnore("Projets/private-company/private-module/package.json", true, failures);
  assertGitIgnore("Projets/README.md", false, failures);
  assertGitIgnore("Projets/_template/README.md", false, failures);

  const companies = companyFolders();
  for (const company of companies) {
    const dsStore = join(company.path, ".DS_Store");
    if (existsSync(dsStore)) {
      console.warn(`[projects] local macOS metadata present and ignored: ${relative(dsStore)}`);
    }
  }

  if (failures.length > 0) {
    console.error("Projects workspace check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`Projects workspace OK (${companies.length} local customer folder(s), private content ignored).`);
}

function initCompany() {
  ensureProjectsDir();
  const slug = args.slug ?? normalizeSlug(args.company ?? "");
  if (!slug) {
    console.error("Missing --slug or --company.");
    process.exit(1);
  }
  const folderName = args.folder ?? slug;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(folderName)) {
    console.error("Company folder must use letters, numbers, dots, dashes or underscores.");
    process.exit(1);
  }

  const companyDir = join(PROJECTS_DIR, folderName);
  mkdirSync(companyDir, { recursive: true });
  mkdirSync(join(companyDir, "vps"), { recursive: true });
  mkdirSync(join(companyDir, "legacy"), { recursive: true });

  const readme = join(companyDir, "README.local.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      `# ${args.company ?? folderName}\n\n` +
        "Private local customer workspace for yaka-bridge.\n\n" +
        "Suggested subprojects:\n\n" +
        `- ${slug}-erp/\n` +
        `- ${slug}-module-<moduleId>/\n` +
        "- vps/\n" +
        "- legacy/\n\n" +
        "Do not commit secrets, customer documents or deployment state to the public template.\n",
      "utf8"
    );
  }

  console.log(`Initialized local customer workspace: ${relative(companyDir)}`);
  console.log("Next: use yaka-bridge-version-modules before creating repos or modules.");
}

function companyFolders() {
  ensureProjectsDir();
  return readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "_template")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const companyPath = join(PROJECTS_DIR, entry.name);
      const projects = readdirSync(companyPath, { withFileTypes: true })
        .filter((child) => child.isDirectory())
        .filter((child) => !child.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => {
          const projectPath = join(companyPath, child.name);
          return {
            name: child.name,
            hasDockerCompose: existsSync(join(projectPath, "docker-compose.yml")),
            hasGit: existsSync(join(projectPath, ".git")),
            hasPackageJson: existsSync(join(projectPath, "package.json")),
            hasReadme: existsSync(join(projectPath, "README.md")) || existsSync(join(projectPath, "README.local.md")),
          };
        });
      return { name: entry.name, path: companyPath, projects };
    });
}

function ensureProjectsDir() {
  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });
}

function assertGitIgnore(path, shouldBeIgnored, failures) {
  const result = spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: ROOT });
  const ignored = result.status === 0;
  if (ignored !== shouldBeIgnored) {
    failures.push(`${path} should ${shouldBeIgnored ? "" : "not "}be ignored by git`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = "1";
    }
  }
  return parsed;
}

function normalizeSlug(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function relative(path) {
  return path.slice(ROOT.length + 1);
}
