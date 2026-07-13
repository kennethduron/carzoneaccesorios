import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]);
const resolutionExtensions = ["", ...sourceExtensions];

const knownPrivilegedPaths = [
  "src/lib/supabase-admin.ts",
  "src/lib/auth/verification-token.ts",
  "src/lib/auth/verification-signing-secret.ts",
  "src/lib/auth/verification-token-core.ts",
  "src/lib/cron.ts",
  "src/lib/cloudinary.ts",
  "src/lib/backups/email.ts",
  "src/lib/backups/google-drive.ts",
  "src/lib/email/email-provider.ts",
  "src/lib/notifications/cron-jobs.ts",
  "src/lib/notifications/email-queue.ts",
];

const sensitiveEnvironmentNames = new Set([
  "SUPABASE_SERVICE_ROLE_KEY",
  "VERIFICATION_SIGNING_SECRET",
  "SUPABASE_ACCESS_TOKEN",
  "RESEND_API_KEY",
  "BREVO_API_KEY",
  "CLOUDINARY_API_SECRET",
  "CRON_SECRET",
  "GOOGLE_DRIVE_PRIVATE_KEY",
  "FCM_PRIVATE_KEY",
  "NEXTAUTH_SECRET",
  "VERCEL_TOKEN",
]);

function normalizePath(value) {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

function relativePath(value) {
  return path.relative(projectRoot, value).replaceAll("\\", "/");
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(absolutePath);
      return sourceExtensions.has(path.extname(entry.name)) ? [absolutePath] : [];
    }),
  );
  return nested.flat();
}

function scriptKind(filePath) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function moduleDirective(sourceFile, value) {
  for (const statement of sourceFile.statements) {
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) {
      if (statement.expression.text === value) return true;
      continue;
    }
    if (ts.isEmptyStatement(statement)) continue;
    break;
  }
  return false;
}

function typeOnlyImport(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  return Boolean(
    !clause.name &&
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly),
  );
}

function typeOnlyExport(node) {
  if (node.isTypeOnly) return true;
  return Boolean(
    node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.length > 0 &&
      node.exportClause.elements.every((element) => element.isTypeOnly),
  );
}

function collectModuleInfo(filePath, source) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const edges = [];
  const environmentReferences = new Set();

  const addEdge = (specifier, kind, node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    edges.push({ specifier, kind, line: line + 1, resolved: null });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && !typeOnlyImport(node)) {
      addEdge(node.moduleSpecifier.text, "import", node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && !typeOnlyExport(node)) {
      addEdge(node.moduleSpecifier.text, "export", node);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addEdge(node.arguments[0].text, "dynamic import", node);
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") addEdge(node.arguments[0].text, "require", node);
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "env" &&
      sensitiveEnvironmentNames.has(node.name.text)
    ) {
      environmentReferences.add(node.name.text);
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "env" &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      sensitiveEnvironmentNames.has(node.argumentExpression.text)
    ) {
      environmentReferences.add(node.argumentExpression.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return {
    filePath,
    source,
    edges,
    environmentReferences,
    useClient: moduleDirective(sourceFile, "use client"),
    useServer: moduleDirective(sourceFile, "use server"),
    serverOnly: edges.some((edge) => edge.specifier === "server-only"),
  };
}

const sourcePaths = await walk(sourceRoot);
const modules = new Map();
for (const filePath of sourcePaths) {
  const source = await readFile(filePath, "utf8");
  modules.set(normalizePath(filePath), collectModuleInfo(filePath, source));
}

function resolveLocalModule(fromFile, specifier) {
  let basePath;
  if (specifier.startsWith("@/")) {
    basePath = path.join(sourceRoot, specifier.slice(2));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    basePath = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }

  for (const extension of resolutionExtensions) {
    const candidate = normalizePath(`${basePath}${extension}`);
    if (modules.has(candidate)) return candidate;
  }
  for (const extension of sourceExtensions) {
    const candidate = normalizePath(path.join(basePath, `index${extension}`));
    if (modules.has(candidate)) return candidate;
  }
  return null;
}

for (const moduleInfo of modules.values()) {
  for (const edge of moduleInfo.edges) {
    edge.resolved = resolveLocalModule(moduleInfo.filePath, edge.specifier);
  }
}

const knownPrivileged = new Set(knownPrivilegedPaths.map((value) => normalizePath(path.join(projectRoot, value))));
const violations = [];
const addViolation = (message) => {
  if (!violations.includes(message)) violations.push(message);
};

const sharedClientPath = normalizePath(path.join(sourceRoot, "lib/supabase.ts"));
const sharedClient = modules.get(sharedClientPath);
if (!sharedClient) {
  addViolation("S1 invariant: src/lib/supabase.ts is missing.");
} else if (/getSupabaseAdminClient|SUPABASE_SERVICE_ROLE_KEY/.test(sharedClient.source)) {
  addViolation("S1 invariant: src/lib/supabase.ts contains a privileged constructor or service-role reference.");
}

const adminPath = normalizePath(path.join(sourceRoot, "lib/supabase-admin.ts"));
const adminModule = modules.get(adminPath);
if (!adminModule?.serverOnly) {
  addViolation("S1 invariant: src/lib/supabase-admin.ts must import server-only.");
}

function reachesPrivilegedExport(modulePath, seen = new Set()) {
  if (knownPrivileged.has(modulePath) || modules.get(modulePath)?.serverOnly) return true;
  if (seen.has(modulePath)) return false;
  seen.add(modulePath);
  const moduleInfo = modules.get(modulePath);
  return Boolean(
    moduleInfo?.edges.some(
      (edge) => edge.kind === "export" && edge.resolved && reachesPrivilegedExport(edge.resolved, seen),
    ),
  );
}

for (const [modulePath, moduleInfo] of modules) {
  if (knownPrivileged.has(modulePath)) continue;
  for (const edge of moduleInfo.edges) {
    if (edge.kind === "export" && edge.resolved && reachesPrivilegedExport(edge.resolved)) {
      addViolation(
        `Privileged re-export: ${relativePath(moduleInfo.filePath)}:${edge.line} exports ${edge.specifier}.`,
      );
    }
  }
}

const clientRoots = [...modules.entries()].filter(([, moduleInfo]) => moduleInfo.useClient);
const clientGraph = new Set();

for (const [rootPath] of clientRoots) {
  const pending = [{ modulePath: rootPath, chain: [rootPath], root: true }];
  const visitedFromRoot = new Set();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visitedFromRoot.has(current.modulePath)) continue;
    visitedFromRoot.add(current.modulePath);
    clientGraph.add(current.modulePath);

    const moduleInfo = modules.get(current.modulePath);
    if (!moduleInfo) continue;
    if (!current.root && moduleInfo.useServer) continue;

    const chain = current.chain.map((value) => relativePath(modules.get(value)?.filePath ?? value)).join(" -> ");

    if (knownPrivileged.has(current.modulePath)) {
      addViolation(`Client graph imports privileged module: ${chain}.`);
    }
    if (moduleInfo.serverOnly) {
      addViolation(`Client graph imports server-only module: ${chain}.`);
    }
    for (const environmentName of moduleInfo.environmentReferences) {
      addViolation(
        `Browser-facing source references privileged environment variable ${environmentName}: ${relativePath(moduleInfo.filePath)}.`,
      );
    }
    for (const edge of moduleInfo.edges) {
      if (!edge.resolved) continue;
      pending.push({ modulePath: edge.resolved, chain: [...current.chain, edge.resolved], root: false });
    }
  }
}

if (violations.length > 0) {
  console.error("Security boundary violation:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Client/server security boundary checks passed.", {
    clientRoots: clientRoots.length,
    browserGraphModules: clientGraph.size,
    knownPrivilegedModules: knownPrivilegedPaths.length,
    coverage: "resolved local static imports, re-exports, literal dynamic imports and literal require calls",
  });
}
