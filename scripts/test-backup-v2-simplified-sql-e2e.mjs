import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDisposableFilesystemStorageProvider } from "../src/lib/backups/v2/disposable-filesystem-storage-provider.ts";
import { canonicalJson, sha256Hex } from "../src/lib/backups/v2/database-artifact-format.ts";
import { provisionDisposablePostgresTarget } from "../src/lib/backups/v2/disposable-postgres-target.ts";
import { createPostgresToolRunner } from "../src/lib/backups/v2/postgres-tool-runner.ts";
import { runSimplifiedBackup } from "../src/lib/backups/v2-simplified/orchestrator.ts";
import {
  createFileBasedPsqlRestoreExecutor,
  createRunnerPlainSqlExporter,
} from "../src/lib/backups/v2-simplified/plain-sql.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "carzone-backup-v2-sql-e2e-"));
const stateParent = path.join(root, "state");
const remoteRoot = path.join(root, "synthetic-remote");
const fixturePath = path.join(root, "synthetic-source-fixture.sql");
const sourceSuffix = randomBytes(6).toString("hex");
const sourceContainer = `carzone-backup-v2-tool-source-${sourceSuffix}`;
const sourcePassword = `SyntheticSource_${randomBytes(18).toString("base64url")}`;
const sourceUser = "carzone_synthetic_source";
const sourceDatabase = "carzone_synthetic_source";
const restorePassword = `SyntheticRestore_${randomBytes(18).toString("base64url")}`;
const recoveryKey = randomBytes(32);
const containers = new Set();
let primaryProvision = null;
let semanticEvidence = null;
let recoveryWorkspaceEvidence = null;

function dockerEnvironment(overrides = {}) {
  const env = {};
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "DOCKER_HOST", "DOCKER_CONTEXT"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, ...overrides };
}

function docker(args, overrides = {}, capture = true) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: dockerEnvironment(overrides),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (capture) stdout = `${stdout}${chunk}`.slice(0, 2_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(0, 16_000); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) { resolve(stdout); return; }
      reject(new Error(`Synthetic Docker command failed (code=${code ?? "none"}, signal=${signal ?? "none"}): ${stderr.replaceAll(sourcePassword, "[redacted]").replaceAll(restorePassword, "[redacted]").slice(0, 2000)}`));
    });
  });
}

async function waitReady(container, user, database, password) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await docker(
        ["exec", "--env", "PGPASSWORD", container, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", user, "-d", database],
        { PGPASSWORD: password },
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Synthetic PostgreSQL 17 source did not become ready");
}

async function removeContainer(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) throw new Error("unsafe synthetic container name");
  await docker(["rm", "-f", name]).catch(() => undefined);
  containers.delete(name);
}

const fixtureSql = String.raw`--
-- PostgreSQL database dump
--
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.products (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL
);
CREATE TABLE public.inventory (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity integer NOT NULL CHECK (quantity >= 0),
  reserved integer NOT NULL CHECK (reserved >= 0 AND reserved <= quantity),
  updated_at timestamptz NOT NULL
);
CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  customer_code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL
);
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_read_policy ON public.customers FOR SELECT USING (true);
CREATE TABLE public.orders (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  order_number text NOT NULL UNIQUE,
  total numeric(12,2) NOT NULL,
  ordered_at timestamptz NOT NULL
);
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  invoice_number text NOT NULL UNIQUE,
  total numeric(12,2) NOT NULL,
  issued_at date NOT NULL
);
CREATE TABLE public.payments (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),
  amount numeric(12,2) NOT NULL,
  received_at timestamptz NOT NULL
);
CREATE TABLE public.accounts_receivable (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),
  original_amount numeric(12,2) NOT NULL,
  balance_due numeric(12,2) NOT NULL,
  due_date date NOT NULL
);
CREATE TABLE public.accounts_payable (
  id uuid PRIMARY KEY,
  supplier_reference text NOT NULL UNIQUE,
  original_amount numeric(12,2) NOT NULL,
  balance_due numeric(12,2) NOT NULL,
  due_date date NOT NULL
);
CREATE TABLE public.accounting_journals (
  id uuid PRIMARY KEY,
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  debit numeric(12,2) NOT NULL,
  credit numeric(12,2) NOT NULL,
  effective_date date NOT NULL,
  CHECK (debit >= 0 AND credit >= 0)
);
CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX inventory_product_idx ON public.inventory(product_id);
CREATE INDEX orders_customer_idx ON public.orders(customer_id);
CREATE INDEX invoices_customer_idx ON public.invoices(customer_id);
CREATE INDEX payments_invoice_idx ON public.payments(invoice_id);
CREATE OR REPLACE FUNCTION public.available_inventory(input_product uuid)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT quantity - reserved FROM public.inventory WHERE product_id = input_product
$$;
CREATE OR REPLACE FUNCTION public.inventory_nonnegative_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantity < 0 OR NEW.reserved < 0 OR NEW.reserved > NEW.quantity THEN
    RAISE EXCEPTION 'invalid inventory';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inventory_nonnegative_trigger
BEFORE INSERT OR UPDATE ON public.inventory
FOR EACH ROW EXECUTE FUNCTION public.inventory_nonnegative_guard();
GRANT SELECT ON public.products TO public;

INSERT INTO public.products VALUES
('11111111-1111-4111-8111-111111111111','SYN-001','Synthetic Recovery Product',125.50,true,'2026-08-22T12:00:00Z');
INSERT INTO public.inventory VALUES
('11111111-1111-4111-8111-111111111112','11111111-1111-4111-8111-111111111111',17,2,'2026-08-22T12:05:00Z');
INSERT INTO public.customers VALUES
('22222222-2222-4222-8222-222222222222','SYN-CUSTOMER-001','Synthetic Customer','2026-08-22T12:10:00Z');
INSERT INTO public.orders VALUES
('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','SYN-ORDER-001',251.00,'2026-08-22T12:15:00Z');
INSERT INTO public.invoices VALUES
('44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','SYN-INVOICE-001',251.00,'2026-08-22');
INSERT INTO public.payments VALUES
('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444',100.00,'2026-08-22T12:20:00Z');
INSERT INTO public.accounts_receivable VALUES
('66666666-6666-4666-8666-666666666666','44444444-4444-4444-8444-444444444444',251.00,151.00,'2026-09-21');
INSERT INTO public.accounts_payable VALUES
('77777777-7777-4777-8777-777777777777','SYN-SUPPLIER-001',80.00,30.00,'2026-09-15');
INSERT INTO public.accounting_journals VALUES
('88888888-8888-4888-8888-888888888888','invoice','44444444-4444-4444-8444-444444444444',251.00,251.00,'2026-08-22');
INSERT INTO public.audit_events VALUES
('99999999-9999-4999-8999-999999999999','order','33333333-3333-4333-8333-333333333333','created','2026-08-22T12:15:01Z');
`;

function sourceRecord(id, body, metadata = {}) {
  const bytes = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body, "utf8");
  return Object.freeze({
    id,
    metadata: Object.freeze({ ...metadata }),
    bodyBytes: BigInt(bytes.length),
    bodySha256: sha256Hex(bytes),
    openBody: () => Readable.from([Buffer.from(bytes)]),
  });
}

function source(component, records) {
  const snapshotId = `synthetic-${component}-snapshot-v1`;
  return Object.freeze({
    component,
    async listPage(cursor) {
      assert.equal(cursor, null);
      return Object.freeze({
        records: Object.freeze(records),
        nextCursor: null,
        snapshotId,
        complete: true,
      });
    },
  });
}

async function queryJson(provision, sql) {
  const output = (await provision.runner.capture({
    tool: "psql",
    operation: "RESTORE_DB_CONTENT_VERIFY",
    args: ["--no-psqlrc", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", `--command=${sql}`],
    connection: {
      host: "127.0.0.1",
      port: 5432,
      database: provision.target.database,
      username: provision.target.user,
      password: provision.target.password,
    },
    containerName: provision.target.containerName,
  })).trim();
  return JSON.parse(output);
}

async function semanticValidation(provision) {
  const sql = `SELECT json_build_object(
    'products',(SELECT count(*) FROM public.products),
    'inventory',(SELECT count(*) FROM public.inventory),
    'customers',(SELECT count(*) FROM public.customers),
    'orders',(SELECT count(*) FROM public.orders),
    'invoices',(SELECT count(*) FROM public.invoices),
    'payments',(SELECT count(*) FROM public.payments),
    'receivables',(SELECT count(*) FROM public.accounts_receivable),
    'payables',(SELECT count(*) FROM public.accounts_payable),
    'journals',(SELECT count(*) FROM public.accounting_journals),
    'audits',(SELECT count(*) FROM public.audit_events),
    'product_ids',(SELECT string_agg(id::text,',' ORDER BY id) FROM public.products),
    'available_inventory',(SELECT public.available_inventory('11111111-1111-4111-8111-111111111111')),
    'invoice_total',(SELECT sum(total)::text FROM public.invoices),
    'payment_total',(SELECT sum(amount)::text FROM public.payments),
    'receivable_balance',(SELECT sum(balance_due)::text FROM public.accounts_receivable),
    'payable_balance',(SELECT sum(balance_due)::text FROM public.accounts_payable),
    'journal_debit',(SELECT sum(debit)::text FROM public.accounting_journals),
    'journal_credit',(SELECT sum(credit)::text FROM public.accounting_journals),
    'invoice_date',(SELECT min(issued_at)::text FROM public.invoices),
    'order_timestamp',(SELECT min(ordered_at)::text FROM public.orders),
    'fk_violations',(SELECT count(*) FROM public.invoices i LEFT JOIN public.orders o ON o.id=i.order_id LEFT JOIN public.customers c ON c.id=i.customer_id WHERE o.id IS NULL OR c.id IS NULL),
    'constraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'),
    'indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public'),
    'functions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('available_inventory','inventory_nonnegative_guard')),
    'triggers',(SELECT count(*) FROM pg_trigger WHERE tgname='inventory_nonnegative_trigger' AND NOT tgisinternal),
    'policies',(SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='customers' AND policyname='customer_read_policy'),
    'rls',(SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='customers'),
    'grant_select',(SELECT EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0 AND a.privilege_type='SELECT') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='products')
  )::text`;
  const evidence = await queryJson(provision, sql.replace(/\s+/g, " ").trim());
  for (const field of ["products", "inventory", "customers", "orders", "invoices", "payments", "receivables", "payables", "journals", "audits"]) {
    assert.equal(evidence[field], 1, `${field} row count`);
  }
  assert.equal(evidence.product_ids, "11111111-1111-4111-8111-111111111111");
  assert.equal(evidence.available_inventory, 15);
  assert.equal(evidence.invoice_total, "251.00");
  assert.equal(evidence.payment_total, "100.00");
  assert.equal(evidence.receivable_balance, "151.00");
  assert.equal(evidence.payable_balance, "30.00");
  assert.equal(evidence.journal_debit, "251.00");
  assert.equal(evidence.journal_credit, "251.00");
  assert.equal(evidence.invoice_date, "2026-08-22");
  assert.match(evidence.order_timestamp, /^2026-08-22 12:15:00/);
  assert.equal(evidence.fk_violations, 0);
  assert.ok(evidence.constraints >= 15);
  assert.ok(evidence.indexes >= 10);
  assert.equal(evidence.functions, 2);
  assert.equal(evidence.triggers, 1);
  assert.equal(evidence.policies, 1);
  assert.equal(evidence.rls, true);
  // The approved export contract deliberately uses --no-privileges.
  assert.equal(evidence.grant_select, false);
  return Object.freeze(evidence);
}

async function actualPsqlFailureProof() {
  const provision = await provisionDisposablePostgresTarget({ password: restorePassword });
  containers.add(provision.target.containerName);
  try {
    const invalidPath = path.join(root, "invalid-mid-restore.sql");
    await writeFile(invalidPath, `${fixtureSql.split("INSERT INTO public.products")[0]}
CREATE TABLE public.before_expected_failure(id integer PRIMARY KEY);
THIS IS AN INTENTIONAL SYNTAX ERROR;
CREATE TABLE public.after_expected_failure(id integer PRIMARY KEY);
`, { flag: "wx", mode: 0o600 });
    const executor = createFileBasedPsqlRestoreExecutor({ target: provision.target, verifyTarget: provision.verify });
    let failure = null;
    try { await executor.restore(invalidPath, provision.target); }
    catch (error) { failure = error; }
    assert.ok(failure);
    assert.equal(failure.code, "BACKUP_V2_PSQL_RESTORE_FAILED");
    assert.notEqual(failure.tool, "pg_restore");
    return "PASS";
  } finally {
    await provision.cleanup();
    containers.delete(provision.target.containerName);
  }
}

async function concurrentIsolationProof() {
  const [left, right] = await Promise.all([
    provisionDisposablePostgresTarget({ password: restorePassword }),
    provisionDisposablePostgresTarget({ password: restorePassword }),
  ]);
  containers.add(left.target.containerName);
  containers.add(right.target.containerName);
  const leftSql = path.join(root, "concurrent-left.sql");
  const rightSql = path.join(root, "concurrent-right.sql");
  await writeFile(leftSql, "--\n-- PostgreSQL database dump\n--\nCREATE TABLE public.concurrent_left(id integer PRIMARY KEY);\n", { flag: "wx", mode: 0o600 });
  await writeFile(rightSql, "--\n-- PostgreSQL database dump\n--\nCREATE TABLE public.concurrent_right(id integer PRIMARY KEY);\n", { flag: "wx", mode: 0o600 });
  try {
    await Promise.all([
      createFileBasedPsqlRestoreExecutor({ target: left.target, verifyTarget: left.verify }).restore(leftSql, left.target),
      createFileBasedPsqlRestoreExecutor({ target: right.target, verifyTarget: right.verify }).restore(rightSql, right.target),
    ]);
    const [leftEvidence, rightEvidence] = await Promise.all([
      queryJson(left, "SELECT json_build_object('left',to_regclass('public.concurrent_left') IS NOT NULL,'right',to_regclass('public.concurrent_right') IS NOT NULL)::text"),
      queryJson(right, "SELECT json_build_object('left',to_regclass('public.concurrent_left') IS NOT NULL,'right',to_regclass('public.concurrent_right') IS NOT NULL)::text"),
    ]);
    assert.deepEqual(leftEvidence, { left: true, right: false });
    assert.deepEqual(rightEvidence, { left: false, right: true });
    return "PASS";
  } finally {
    await Promise.all([left.cleanup(), right.cleanup()]);
    containers.delete(left.target.containerName);
    containers.delete(right.target.containerName);
  }
}

try {
  await writeFile(fixturePath, fixtureSql, { flag: "wx", mode: 0o600 });
  await docker([
    "run", "--detach", "--name", sourceContainer,
    "--label", "com.carzone.backup-v2.test=synthetic-source",
    "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_PASSWORD",
    "--env", "POSTGRES_USER",
    "--env", "POSTGRES_DB",
    "postgres:17-alpine",
  ], {
    POSTGRES_PASSWORD: sourcePassword,
    POSTGRES_USER: sourceUser,
    POSTGRES_DB: sourceDatabase,
  });
  containers.add(sourceContainer);
  await waitReady(sourceContainer, sourceUser, sourceDatabase, sourcePassword);
  await docker(["cp", fixturePath, `${sourceContainer}:/tmp/synthetic-source-fixture.sql`]);
  await docker([
    "exec", "--env", "PGPASSWORD", sourceContainer,
    "psql", "-X", "--set", "ON_ERROR_STOP=on",
    "-h", "127.0.0.1", "-p", "5432", "-U", sourceUser, "-d", sourceDatabase,
    "-f", "/tmp/synthetic-source-fixture.sql",
  ], { PGPASSWORD: sourcePassword }, false);

  const runner = createPostgresToolRunner({ mode: "CONTAINER" });
  const connection = {
    host: "127.0.0.1",
    port: 5432,
    database: sourceDatabase,
    username: sourceUser,
    password: sourcePassword,
  };
  const exporter = await createRunnerPlainSqlExporter({
    runner,
    connection,
    containerName: sourceContainer,
  });
  assert.match(exporter.toolVersion, /^pg_dump \(PostgreSQL\) 17\./);

  const storageIdentity = canonicalJson({ bucket: "synthetic", key: "products/fixture.bin" });
  const storageBucketIdentity = canonicalJson({ bucket: "synthetic", key: null });
  const authBody = canonicalJson({ email: "synthetic-user@example.invalid", id: "synthetic-auth-user-1" });
  const bucketMetadataBody = canonicalJson({ bucket: "synthetic", key: null, public: false });
  const metadataBody = canonicalJson({ bucket: "synthetic", key: "products/fixture.bin", size: 22 });
  const storageBody = Buffer.from("synthetic-object-body", "utf8");
  const externalBody = Buffer.from("synthetic-cloudinary-original", "utf8");
  const auth = source("auth", [
    sourceRecord(canonicalJson({ table: "users", pk: { id: "synthetic-auth-user-1" } }), authBody, { table: "users" }),
  ]);
  const storageMetadata = source("storage_metadata", [
    sourceRecord(storageBucketIdentity, bucketMetadataBody, { bucket: "synthetic", key: null }),
    sourceRecord(storageIdentity, metadataBody, { bucket: "synthetic", key: "products/fixture.bin" }),
  ]);
  const storageObjects = source("storage_objects", [
    sourceRecord(storageIdentity, storageBody, { bucket: "synthetic", key: "products/fixture.bin" }),
  ]);
  const externalAssets = source("external_assets", [
    sourceRecord(canonicalJson({ public_id: "synthetic-asset", resource_type: "image", type: "upload", version: "1" }), externalBody, { format: "bin" }),
  ]);
  const storageProvider = await createDisposableFilesystemStorageProvider({
    root: remoteRoot,
    providerInstanceId: "synthetic-plain-sql-storage",
    namespaceId: "synthetic-plain-sql-namespace",
    failureDomain: "local-synthetic-only",
  });

  const stages = [];
  const result = await runSimplifiedBackup({
    stateParent,
    sources: Object.freeze({
      database: exporter,
      auth,
      storageMetadata,
      storageObjects,
      externalAssets,
      mutationMethods: Object.freeze([]),
      async measureCanonicalSource() {
        return Object.freeze({
          databaseBytes: BigInt(2_000_000),
          databaseObjects: BigInt(10),
          authBytes: BigInt(Buffer.byteLength(authBody)),
          authObjects: BigInt(1),
          storageMetadataBytes: BigInt(Buffer.byteLength(bucketMetadataBody) + Buffer.byteLength(metadataBody)),
          storageMetadataObjects: BigInt(2),
          storageObjectBytes: BigInt(storageBody.length),
          storageObjects: BigInt(1),
          externalAssetBytes: BigInt(externalBody.length),
          externalAssets: BigInt(1),
        });
      },
      async cleanup() {},
    }),
    recoveryKey,
    storageProvider,
    sourceDatabaseUrl: "postgresql://synthetic-source.invalid/carzone_synthetic_source",
    availableDiskBytes: async () => BigInt(100_000_000_000),
    minimumDiskSafetyMarginBytes: BigInt(0),
    stageHook: async (stageName) => {
      stages.push(stageName);
      if (stageName === "RECOVERY_VERIFICATION") {
        const runDirectories = await readdir(stateParent);
        assert.equal(runDirectories.length, 1);
        const restoreRoot = path.join(stateParent, runDirectories[0], "restore");
        const componentCounts = {};
        for (const component of ["auth", "storage_metadata", "storage_objects", "external_assets"]) {
          const inventory = await readFile(path.join(restoreRoot, component, "inventory.jsonl"), "utf8");
          componentCounts[component] = inventory.trim().split("\n").filter(Boolean).length;
        }
        await assert.rejects(stat(path.join(restoreRoot, "database", "database.sql")), { code: "ENOENT" });
        recoveryWorkspaceEvidence = Object.freeze(componentCounts);
      }
    },
    async restore() {
      primaryProvision = await provisionDisposablePostgresTarget({ password: restorePassword });
      containers.add(primaryProvision.target.containerName);
      return Object.freeze({
        target: primaryProvision.target,
        executor: createFileBasedPsqlRestoreExecutor({
          target: primaryProvision.target,
          verifyTarget: primaryProvision.verify,
        }),
        async verifyDatabase() {
          semanticEvidence = await semanticValidation(primaryProvision);
          return semanticEvidence;
        },
        async cleanup() {
          await primaryProvision.cleanup();
          containers.delete(primaryProvision.target.containerName);
          primaryProvision = null;
        },
      });
    },
  });

  assert.equal(result.report.backupV2Simplified, "RECOVERABILITY_PROVEN");
  assert.equal(result.report.recoverabilityProven, true);
  assert.equal(result.report.backupVerified, true);
  assert.equal(result.report.remoteObjectsVerified, 12);
  assert.equal(result.report.cleanup, "PASS");
  assert.equal(result.report.productionMutation, "NONE");
  assert.equal(result.report.fullDrReady, false);
  assert.deepEqual(result.report.componentResults, {
    database: "PASS",
    auth: "PASS",
    storage_metadata: "PASS",
    storage_objects: "PASS",
    external_assets: "PASS",
  });
  assert.deepEqual(recoveryWorkspaceEvidence, {
    auth: 1,
    storage_metadata: 2,
    storage_objects: 1,
    external_assets: 1,
  });
  assert.ok(semanticEvidence);
  assert.ok(stages.includes("DATABASE_EXPORT"));
  assert.ok(stages.includes("ISOLATED_RESTORE"));
  assert.ok(stages.includes("RECOVERY_VERIFICATION"));
  for (const removed of ["staging", "download", "restore"]) {
    await assert.rejects(stat(path.join(result.stateRoot, removed)), { code: "ENOENT" });
  }
  const remoteFiles = (await readdir(remoteRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile());
  assert.equal(remoteFiles.length, 12);

  const psqlMidRestoreFailure = await actualPsqlFailureProof();
  const concurrentRestoreIsolation = await concurrentIsolationProof();

  process.stdout.write(`${JSON.stringify({
    adversarialPsqlMidRestoreFailure: psqlMidRestoreFailure,
    authComponent: "PASS",
    cleanup: "PASS",
    concurrentRestoreIsolation,
    dockerCopy: "PASS",
    externalAssetsComponent: "PASS",
    fileBasedPsql: "PASS",
    pgDumpVersion: exporter.toolVersion,
    plaintextCleanup: "PASS",
    postgresComponent: "PASS",
    postgresRepresentation: "postgres_plain_sql_v1",
    postgresTargetVersion: "17",
    primaryRestoreStrategy: "psql_file_restore_v1",
    psqlOnErrorStop: "PASS",
    semanticValidation: "PASS",
    storageMetadataComponent: "PASS",
    storageObjectComponent: "PASS",
    structuralValidation: "PASS",
    syntheticE2E: "PASS",
  })}\n`);
} finally {
  recoveryKey.fill(0);
  if (primaryProvision) {
    await primaryProvision.cleanup().catch(() => undefined);
    containers.delete(primaryProvision.target.containerName);
  }
  for (const container of [...containers]) await removeContainer(container);
  await rm(root, { recursive: true, force: true });
}
