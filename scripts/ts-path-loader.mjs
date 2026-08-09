import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: "data:text/javascript,export {};", shortCircuit: true };
  }
  if (!specifier.startsWith("@/")) {
    return nextResolve(specifier, context);
  }

  const target = path.resolve(sourceRoot, specifier.slice(2));
  for (const extension of ["", ".ts", ".tsx", ".js", ".mjs"]) {
    const candidate = `${target}${extension}`;
    try {
      await access(candidate);
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
    } catch {
      // Try the next supported source extension.
    }
  }

  return nextResolve(specifier, context);
}
