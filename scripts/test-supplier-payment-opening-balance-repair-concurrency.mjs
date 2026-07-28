import assert from "node:assert/strict";

const baseUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const parsedUrl = new URL(baseUrl);

assert.ok(
  parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost",
  "This concurrency test refuses to target a non-local Supabase instance.",
);
assert.equal(
  parsedUrl.port,
  "54321",
  "This concurrency test only accepts the standard local Supabase API port.",
);
assert.ok(serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY is required.");

const endpoint = new URL(
  "/rest/v1/rpc/repair_existing_supplier_card_payment_v1",
  parsedUrl,
);
const requestBody = JSON.stringify({
  target_payment_id: "fd93d49b-e4b3-4dcc-a0ca-5feb0488c804",
  target_event_id: "6dd1e200-f628-450e-8bfc-f8a6c700b442",
  obligation_journal_id: "5843045f-db47-429c-ad19-f75dc61cdd3e",
  repair_actor_id: "91000000-0000-4000-8000-000000000001",
});

async function invokeRepair() {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: requestBody,
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

const [left, right] = await Promise.all([invokeRepair(), invokeRepair()]);
const statuses = [left.status, right.status].sort();

assert.deepEqual(statuses, ["already_repaired", "repaired"]);
assert.equal(left.journal_entry_id, right.journal_entry_id);
assert.equal(left.journal_status, "borrador");
assert.equal(right.journal_status, "borrador");
assert.equal(
  [left.idempotent_replay, right.idempotent_replay].filter(Boolean).length,
  1,
);

console.log(
  JSON.stringify({
    ok: true,
    statuses,
    sameJournalEntry: true,
    journalStatus: "borrador",
  }),
);
