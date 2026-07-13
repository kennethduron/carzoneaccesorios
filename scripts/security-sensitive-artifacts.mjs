import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateDirectories = ["tmp", "backups", "exports", "downloads"];
const sensitiveNamePattern = /(production|prod[-_. ]|backup|dump|export|customer|cliente|supplier|proveedor|user|usuario|payment|pago|accounting|contabilidad|auth|credential|secret|private)/i;
const sensitiveExtensions = new Set([".env", ".zip", ".bak", ".backup", ".dump", ".sql", ".json", ".csv", ".xlsx", ".xls", ".log", ".pem", ".key"]);
const codeExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"]);

function toRelative(filePath) {
  return path.relative(projectRoot, filePath).replaceAll("\\", "/");
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolutePath) : [absolutePath];
  });
}

function isCandidate(filePath, rootLevel = false) {
  const name = path.basename(filePath);
  const extension = path.extname(name).toLowerCase();
  if (name.startsWith(".env")) return true;
  if (rootLevel) return sensitiveNamePattern.test(name) || [".zip", ".bak", ".backup", ".dump", ".sql", ".csv", ".xlsx", ".xls", ".pem", ".key"].includes(extension);
  return sensitiveNamePattern.test(name) || sensitiveExtensions.has(extension);
}

function riskCategory(filePath) {
  const name = path.basename(filePath);
  const location = toRelative(filePath);
  const extension = path.extname(name).toLowerCase();
  if (name.startsWith(".env") || [".pem", ".key"].includes(extension) || /(credential|secret|private)/i.test(name)) return "critical";
  if (codeExtensions.has(extension)) return "review";
  if ([".zip", ".bak", ".backup", ".dump", ".sql"].includes(extension) || /(production|backup|dump|customer|cliente|supplier|proveedor|user|usuario|payment|pago|accounting|contabilidad|auth)/i.test(location)) return "high";
  return "medium";
}

const trackedResult = spawnSync("git", ["ls-files", "-z"], { cwd: projectRoot, encoding: "utf8" });
if (trackedResult.status !== 0) {
  console.error("Sensitive artifact inventory could not read the Git index.");
  process.exit(1);
}
const trackedFiles = new Set(trackedResult.stdout.split("\0").filter(Boolean).map((value) => value.replaceAll("\\", "/")));

const candidateFiles = [];
for (const directory of candidateDirectories) {
  const absoluteDirectory = path.join(projectRoot, directory);
  if (!existsSync(absoluteDirectory)) continue;
  for (const filePath of walk(absoluteDirectory)) {
    if (isCandidate(filePath)) candidateFiles.push(filePath);
  }
}
for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const filePath = path.join(projectRoot, entry.name);
  if (isCandidate(filePath, true)) candidateFiles.push(filePath);
}

const uniqueFiles = [...new Set(candidateFiles)].sort((left, right) => left.localeCompare(right));
const oneDriveWarning = projectRoot.toLowerCase().includes(`${path.sep}onedrive${path.sep}`) ? "yes" : "no";
let unsafeCount = 0;

console.log("Sensitive local artifact inventory (contents are never read):");
if (uniqueFiles.length === 0) console.log("- No candidates found.");

for (const filePath of uniqueFiles) {
  const relative = toRelative(filePath);
  const tracked = trackedFiles.has(relative);
  const ignoredResult = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", relative], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  const ignored = ignoredResult.status === 0;
  if (tracked || !ignored) unsafeCount += 1;

  console.log(
    `- ${relative} | ${statSync(filePath).size} bytes | risk=${riskCategory(filePath)} | tracked=${tracked ? "yes" : "no"} | ignored=${ignored ? "yes" : "no"} | OneDrive=${oneDriveWarning}`,
  );
}

console.log("Inventory summary:", {
  candidates: uniqueFiles.length,
  unsafe: unsafeCount,
  oneDriveProject: oneDriveWarning === "yes",
  destructiveActions: 0,
});

if (unsafeCount > 0) {
  console.error("Sensitive artifact protection failure: at least one candidate is Git tracked or not ignored.");
  process.exitCode = 1;
}
