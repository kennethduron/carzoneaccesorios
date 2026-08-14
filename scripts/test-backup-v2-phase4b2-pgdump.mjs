import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import {
  DATABASE_ARTIFACT_HEADER_BYTES,
  DATABASE_AUTH_TAG_BYTES,
  databaseArtifactAadBytes,
} from "../src/lib/backups/v2/database-artifact-format.ts";
import {
  runDatabaseArtifactPipeline,
  verifyDatabaseArtifact,
} from "../src/lib/backups/v2/database-artifact-pipeline.ts";

const syntheticSchema = `
create type public.synthetic_status as enum ('draft', 'ready');
create table public.synthetic_parent (
  id bigint generated always as identity primary key,
  code text not null unique,
  status public.synthetic_status not null default 'draft'
);
create table public.synthetic_child (
  id bigint generated always as identity primary key,
  parent_id bigint not null references public.synthetic_parent(id),
  quantity integer not null check (quantity > 0)
);
create index synthetic_child_parent_idx on public.synthetic_child(parent_id);
create view public.synthetic_ready as
  select id, code from public.synthetic_parent where status = 'ready';
create function public.synthetic_quantity_total(input_parent_id bigint)
returns bigint language sql stable set search_path = ''
as $$ select coalesce(sum(quantity), 0)::bigint from public.synthetic_child where parent_id = input_parent_id $$;
alter table public.synthetic_parent enable row level security;
create policy synthetic_parent_read on public.synthetic_parent for select using (true);
insert into public.synthetic_parent(code, status) values ('alpha', 'ready'), ('beta', 'draft');
insert into public.synthetic_child(parent_id, quantity)
select id, case code when 'alpha' then 3 else 5 end from public.synthetic_parent;
`;

function safeProcessEnvironment() {
  const environment = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TMP", "TEMP"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function runDocker(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: safeProcessEnvironment(),
      shell: false,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(0, 64_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(0, 8_000); });
    child.once("error", () => reject(new Error("Docker command could not start")));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(new Error(`Docker command failed (code ${code ?? "none"}, signal ${signal ?? "none"})`));
        return;
      }
      resolve(stdout.trim());
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  });
}

async function waitForPostgres(containerName, password) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await runDocker([
        "exec", "-e", `PGPASSWORD=${password}`, containerName,
        "psql", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
        "-c", "select 1",
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Disposable PostgreSQL did not become ready");
}

function dockerPgDumpExporter(containerName, password, toolVersion) {
  return {
    tool: "pg_dump",
    toolVersion,
    format: "postgresql_custom",
    open(signal) {
      const child = spawn("docker", [
        "exec", "-e", `PGPASSWORD=${password}`, containerName,
        "pg_dump", "-U", "postgres", "-d", "synthetic_source",
        "--format=custom", "--no-owner", "--no-privileges",
      ], {
        env: safeProcessEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(0, 8_000); });
      const cancel = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
      if (signal?.aborted) cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      const completed = new Promise((resolve, reject) => {
        child.once("error", () => reject(new Error("Disposable pg_dump could not start")));
        child.once("close", (code, exitSignal) => {
          signal?.removeEventListener("abort", cancel);
          if (code === 0 && exitSignal === null) resolve();
          else reject(new Error(`Disposable pg_dump failed (code ${code ?? "none"})`));
        });
      });
      return { stream: child.stdout, completed, cancel };
    },
  };
}

async function restoreRoundTrip(containerName, password, result, key) {
  await runDocker([
    "exec", "-e", `PGPASSWORD=${password}`, containerName,
    "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
    "-c", "create database synthetic_restore",
  ]);
  const manifest = JSON.parse(await readFile(result.paths.manifestPath, "utf8"));
  const artifactStat = await stat(result.paths.artifactPath);
  const artifactSize = BigInt(artifactStat.size);
  const handle = await open(result.paths.artifactPath, "r");
  const header = Buffer.alloc(DATABASE_ARTIFACT_HEADER_BYTES);
  const authTag = Buffer.alloc(DATABASE_AUTH_TAG_BYTES);
  try {
    await handle.read(header, 0, header.length, 0);
    await handle.read(authTag, 0, authTag.length, Number(artifactSize - BigInt(DATABASE_AUTH_TAG_BYTES)));
  } finally {
    await handle.close();
  }
  const nonce = header.subarray(header.length - 12);
  const aad = databaseArtifactAadBytes({
    runId: manifest.run_id,
    generationKey: manifest.generation_key,
    artifactId: manifest.artifact_id,
    createdAt: manifest.created_at,
    catalogFingerprint: manifest.catalog.fingerprint,
    catalogPolicyVersion: manifest.catalog.policy_version,
    preflightSnapshotId: manifest.preflight.snapshot_id,
    keyVersion: manifest.encryption.key_version,
    keyReference: manifest.encryption.key_reference,
    keyFingerprint: manifest.encryption.key_fingerprint,
    exportTool: manifest.export.tool,
    exportToolVersion: manifest.export.tool_version,
    compressionLevel: manifest.compression.level,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: DATABASE_AUTH_TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  const restore = spawn("docker", [
    "exec", "-i", "-e", `PGPASSWORD=${password}`, containerName,
    "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges",
    "-U", "postgres", "-d", "synthetic_restore",
  ], {
    env: safeProcessEnvironment(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  restore.stdout.resume();
  restore.stderr.resume();
  const completed = new Promise((resolve, reject) => {
    restore.once("error", () => reject(new Error("Disposable pg_restore could not start")));
    restore.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`Disposable pg_restore failed (code ${code ?? "none"})`));
    });
  });
  await pipeline(
    createReadStream(result.paths.artifactPath, {
      start: DATABASE_ARTIFACT_HEADER_BYTES,
      end: Number(artifactSize - BigInt(DATABASE_AUTH_TAG_BYTES) - 1n),
    }),
    decipher,
    createGunzip(),
    restore.stdin,
  );
  await completed;

  const proof = await runDocker([
    "exec", "-e", `PGPASSWORD=${password}`, containerName,
    "psql", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "synthetic_restore",
    "-c", "select (select count(*) from public.synthetic_parent)::text || '|' || (select count(*) from public.synthetic_child)::text || '|' || (select count(*) from public.synthetic_ready)::text || '|' || public.synthetic_quantity_total(1)::text || '|' || (select count(*) from pg_policies where schemaname='public' and tablename='synthetic_parent')::text",
  ]);
  assert.equal(proof, "2|2|1|3|1");
}

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "carzone-phase4b2-pgdump-"));
const containerName = `carzone-phase4b2-${process.pid}-${Date.now()}`;
const password = randomBytes(24).toString("base64url");
const key = randomBytes(32);
let containerStarted = false;
let currentStage = "container-start";
try {
  await runDocker([
    "run", "--detach", "--rm", "--name", containerName,
    "--env", `POSTGRES_PASSWORD=${password}`,
    "postgres:17-alpine",
  ]);
  containerStarted = true;
  currentStage = "postgres-readiness";
  await waitForPostgres(containerName, password);
  currentStage = "source-database-create";
  await runDocker([
    "exec", "-e", `PGPASSWORD=${password}`, containerName,
    "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
    "-c", "create database synthetic_source",
  ]);
  currentStage = "synthetic-schema-seed";
  await runDocker([
    "exec", "-i", "-e", `PGPASSWORD=${password}`, containerName,
    "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "synthetic_source",
  ], { stdin: syntheticSchema });
  currentStage = "pg-dump-version";
  const toolVersion = await runDocker(["exec", containerName, "pg_dump", "--version"]);
  assert.match(toolVersion, /^pg_dump \(PostgreSQL\) 17\./);

  const generationKey = `backup-v2-generation:${"d".repeat(64)}`;
  const authorityState = {
    runId: "run-disposable-pgdump",
    generationKey,
    state: "running",
    preflightOutcome: "go",
    preflightSnapshotId: "preflight-disposable-pgdump",
    catalogFingerprint: "c".repeat(64),
    catalogPolicyVersion: "car-zone-phase4b1-catalog-v2",
    lease: {
      ownerRef: "worker-disposable",
      acquiredAt: "2026-08-14T13:00:00.000Z",
      heartbeatAt: "2026-08-14T13:20:00.000Z",
      expiresAt: "2026-08-14T14:00:00.000Z",
      generation: 11,
    },
  };
  currentStage = "artifact-pipeline";
  const result = await runDatabaseArtifactPipeline({
    workspaceRoot,
    recoverySetId: "recovery-set-disposable",
    ownerRef: "worker-disposable",
    leaseGeneration: 11,
    authority: { async read() { return structuredClone(authorityState); } },
    exporter: dockerPgDumpExporter(containerName, password, toolVersion),
    encryptionKey: key,
    keyVersion: "ephemeral-disposable-v1",
    keyReference: "ephemeral:disposable-runtime-only",
    compatibilityRef: "postgresql-17:custom-archive:synthetic",
    clock: () => "2026-08-14T13:30:00.000Z",
  });
  currentStage = "artifact-verification";
  const verified = await verifyDatabaseArtifact({
    artifactPath: result.paths.artifactPath,
    manifestPath: result.paths.manifestPath,
    encryptionKey: key,
    expected: {
      runId: authorityState.runId,
      generationKey,
      artifactId: result.paths.artifactId,
      catalogFingerprint: authorityState.catalogFingerprint,
      preflightSnapshotId: authorityState.preflightSnapshotId,
    },
  });
  assert.ok(verified.plaintextBytes > 0n);
  assert.equal(result.manifest.export.format, "postgresql_custom");
  currentStage = "pg-restore-round-trip";
  await restoreRoundTrip(containerName, password, result, key);
  console.log(`Backup V2 Phase 4B.2 disposable pg_dump/pg_restore round-trip: PASS (${toolVersion})`);
} catch (error) {
  throw new Error(`Disposable PostgreSQL stage failed: ${currentStage}`, { cause: error });
} finally {
  key.fill(0);
  if (containerStarted) {
    await runDocker(["rm", "--force", containerName]).catch(() => undefined);
  }
  const resolved = path.resolve(workspaceRoot);
  assert.ok(path.basename(resolved).startsWith("carzone-phase4b2-pgdump-"));
  await rm(resolved, { recursive: true, force: true });
}
