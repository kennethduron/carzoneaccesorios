import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";

const workflowUrl = new URL("../.github/workflows/backup-v2-preflight.yml", import.meta.url);
const workflowText = await readFile(workflowUrl, "utf8");
const workflow = yaml.load(workflowText, { schema: yaml.JSON_SCHEMA });
assert.equal(typeof workflow, "object");
assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
assert.deepEqual(workflow.permissions, { contents: "read" });
assert.deepEqual(workflow.concurrency, { group: "backup-v2-phase4a-preflight", "cancel-in-progress": false });
assert.deepEqual(Object.keys(workflow.jobs), ["phase4a-contracts"]);
const job = workflow.jobs["phase4a-contracts"];
assert.equal(job["runs-on"], "ubuntu-latest");
assert.equal(job["timeout-minutes"], 15);
assert.equal(job.environment, undefined);
assert.equal(job.env, undefined);
assert.ok(Array.isArray(job.steps));
const uses = job.steps.filter((step) => step.uses).map((step) => step.uses);
assert.deepEqual(uses, [
  "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
]);
assert.equal(job.steps[0].with["persist-credentials"], false);
assert.equal(job.steps[1].with["node-version"], "22");
const commands = job.steps.filter((step) => step.run).map((step) => step.run);
assert.deepEqual(commands, [
  "npm ci --ignore-scripts",
  "node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-backup-v2-foundation.mjs",
  "node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-backup-v2-zero-spend.mjs",
  "node scripts/test-backup-v2-workflow-contract.mjs",
  "npx tsc --noEmit",
  "npx eslint src/lib/backups/v2 scripts/test-backup-v2-foundation.mjs scripts/test-backup-v2-zero-spend.mjs scripts/test-backup-v2-workflow-contract.mjs",
]);
const serialized = JSON.stringify(workflow).toLowerCase();
for (const forbidden of ["secrets.", "postgres://", "postgresql://", "service_role", "supabase db",
  "pg_dump", "upload-artifact", "download-artifact", "backblaze", "cloudflare", "google drive",
  "aws s3", "rclone", "restore", "delete", "truncate", "drop table", "schedule"] ) {
  assert.equal(serialized.includes(forbidden), false, `workflow contains forbidden semantic: ${forbidden}`);
}
console.log("Backup V2 preflight workflow contract: PASS");
