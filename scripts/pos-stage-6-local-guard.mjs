import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const requestedMarker = process.env.POS_TEST_MARKER_PREFIX?.trim();
export const stage6Marker = requestedMarker || "POS-STAGE6-LOCAL-ONLY";
assert.match(stage6Marker, /^POS-[A-Z0-9-]+-LOCAL-ONLY$/, "The local test marker must be explicit and isolated.");
export const protectedProductionRef = "mbowrapstbufzzfefipn";

export function readStage6LocalStatus() {
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npx.cmd supabase status -o json"]
    : ["supabase", "status", "-o", "json"];
  const raw = execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw);
}

function databaseContainer() {
  const names = execFileSync("docker", ["ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim().split(/\r?\n/).filter(Boolean);
  const matches = names.filter((name) => name === "supabase_db_car-zone-accesorios");
  assert.equal(matches.length, 1, "The expected isolated local database container must be running exactly once.");
  return matches[0];
}

export function assertStage6LocalEnvironment() {
  const sensitiveValues = Object.entries(process.env)
    .filter(([name]) => /(SUPABASE|DATABASE|POSTGRES|VERCEL)/i.test(name))
    .map(([name, value]) => `${name}=${value ?? ""}`);
  assert.equal(
    sensitiveValues.some((entry) => entry.includes(protectedProductionRef)),
    false,
    "Protected production project ref detected; Stage 6 mutating tests aborted.",
  );

  const status = readStage6LocalStatus();
  const api = new URL(status.API_URL);
  const database = new URL(status.DB_URL);
  assert.match(api.hostname, /^(127\.0\.0\.1|localhost)$/);
  assert.equal(api.port, "54321");
  assert.match(database.hostname, /^(127\.0\.0\.1|localhost)$/);
  assert.equal(database.port, "54322");
  assert.equal(database.pathname, "/postgres");

  const container = databaseContainer();
  const identity = execFileSync("docker", [
    "exec", container, "psql", "-U", "postgres", "-d", "postgres", "-At",
    "-F", "|", "-c",
    "select current_database(), current_user, inet_server_addr(), inet_server_port();",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const [databaseName, databaseUser, serverAddress, serverPort] = identity.split("|");
  const verifiedServerAddress = serverAddress || "(local-unix-socket)";
  const verifiedServerPort = serverPort ? Number(serverPort) : null;
  assert.equal(databaseName, "postgres");
  assert.equal(databaseUser, "postgres");
  assert.notEqual(verifiedServerAddress, protectedProductionRef);
  assert.ok(verifiedServerPort === null || verifiedServerPort === 5432);

  return {
    apiUrl: status.API_URL,
    databaseUrl: status.DB_URL.replace(/:[^:@/]+@/, ":***@"),
    databaseName,
    databaseUser,
    serverAddress: verifiedServerAddress,
    serverPort: verifiedServerPort,
    container,
    productionRefProtected: protectedProductionRef,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("POS Stage 6 local guard: PASS", assertStage6LocalEnvironment());
}
