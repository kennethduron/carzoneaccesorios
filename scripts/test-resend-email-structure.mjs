import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const provider = await readFile(new URL("../src/lib/email/email-provider.ts", import.meta.url), "utf8");
const queue = await readFile(new URL("../src/lib/notifications/email-queue.ts", import.meta.url), "utf8");
const orderEmail = await readFile(new URL("../src/lib/notifications/order-email.ts", import.meta.url), "utf8");
const publicForms = await readFile(new URL("../src/lib/public-form-support.ts", import.meta.url), "utf8");
const authActions = await readFile(new URL("../src/app/auth/actions.ts", import.meta.url), "utf8");
const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");

assert.match(provider, /EMAIL_PROVIDER/);
assert.match(provider, /EMAIL_ENABLED/);
assert.match(provider, /RESEND_FROM_EMAIL/);
assert.match(provider, /RESEND_FROM_NAME/);
assert.match(provider, /reply_to: process\.env\.RESEND_REPLY_TO/);
assert.match(provider, /Idempotency-Key/);

for (const key of [
  "EMAIL_PROVIDER=resend",
  "EMAIL_ENABLED=true",
  "RESEND_API_KEY=",
  "RESEND_FROM_EMAIL=sistema@carzoneaccesorios.com",
  "RESEND_FROM_NAME=Car Zone Accesorios",
  "RESEND_REPLY_TO=",
]) {
  assert.match(envExample, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

assert.match(queue, /from\("email_queue"\)/);
assert.match(queue, /sendTransactionalEmail/);
assert.match(queue, /provider_message_id/);

assert.match(orderEmail, /queuePreferenceEmail/);
assert.match(orderEmail, /customer\.order_received/);
assert.match(orderEmail, /customer_updates_disabled/);
assert.match(orderEmail, /input\.eventType === "order\.cancelled" \|\| input\.eventType === "payment\.rejected"/);
assert.match(publicForms, /public_form\.\$\{input\.kind\}\.requester/);
assert.match(publicForms, /queuePreferenceEmail/);

assert.match(authActions, /supabase\.auth\.signUp/);
assert.match(authActions, /supabase\.auth\.resend/);
assert.match(authActions, /resetPasswordForEmail/);

const srcEmailSearch = spawnSync("rg", ["-n", "[A-Za-z0-9._%+-]+@carzoneaccesorios\\.com", "src"], {
  encoding: "utf8",
});
assert.ok(srcEmailSearch.status === 0 || srcEmailSearch.status === 1, srcEmailSearch.stderr);
const srcEmailReferences = srcEmailSearch.stdout.trim();
assert.equal(srcEmailReferences, "", `Do not hardcode unverified carzoneaccesorios.com emails in src:\n${srcEmailReferences}`);

console.log("Resend email structure checks passed.");
