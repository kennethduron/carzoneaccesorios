import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.resolve(process.env.INVOICE_LOGO_EVIDENCE_DIR ?? path.join(projectRoot, "tmp/invoice-logo-evidence"));
const publicRoot = path.join(projectRoot, "public");
const port = Number(process.env.INVOICE_LOGO_EVIDENCE_PORT ?? "4173");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".png", "image/png"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
]);

function safePath(root, requestPath) {
  const candidate = path.resolve(root, `.${requestPath}`);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const decodedPath = decodeURIComponent(requestUrl.pathname === "/" ? "/invoice-after.html" : requestUrl.pathname);
  const root = decodedPath.startsWith("/brand/") ? publicRoot : evidenceRoot;
  const filePath = safePath(root, decodedPath);
  if (!filePath) {
    response.writeHead(400).end("Invalid path");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
      "cache-control": "no-store",
      ...(path.extname(filePath).toLowerCase() === ".pdf"
        ? { "content-disposition": `${requestUrl.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${path.basename(filePath)}"` }
        : {}),
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`invoice-logo-evidence-ready http://127.0.0.1:${port}`);
});
