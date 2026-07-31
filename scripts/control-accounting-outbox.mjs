import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const [action, outboxId, reason, envPath] = process.argv.slice(2);
assert.match(action ?? "", /^(hold|release)$/);
assert.match(outboxId ?? "", /^[0-9a-f-]{36}$/i);
assert.ok(reason && envPath, "Expected action, outbox UUID, reason, and env file.");

const env = Object.fromEntries(
  (await readFile(envPath, "utf8"))
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
assert.ok(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const functionName =
  action === "hold"
    ? "hold_accounting_outbox_v1"
    : "release_accounting_outbox_v1";
const parameters =
  action === "hold"
    ? { p_outbox_id: outboxId, p_reason: reason }
    : { p_outbox_id: outboxId, p_expected_reason: reason };

const { data: operation, error: operationError } = await db.rpc(
  functionName,
  parameters,
);
assert.ifError(operationError);

const { data: row, error: rowError } = await db
  .from("accounting_outbox_v2")
  .select(
    "id,status,attempt_count,max_attempts,processing_hold,hold_reason,held_at,held_by,next_attempt_at,financial_event_id,journal_entry_id",
  )
  .eq("id", outboxId)
  .single();
assert.ifError(rowError);

const { data: due, error: dueError } = await db.rpc(
  "claim_due_accounting_outbox_v2",
  { batch_size: 100 },
);
assert.ifError(dueError);
const claimable = (due ?? []).some(({ outbox_id: id }) => id === outboxId);

if (action === "hold") {
  assert.equal(row.processing_hold, true);
  assert.equal(row.hold_reason, reason);
  assert.equal(claimable, false);
} else {
  assert.equal(row.processing_hold, false);
}

console.log(JSON.stringify({ operation, row, claimable }, null, 2));
