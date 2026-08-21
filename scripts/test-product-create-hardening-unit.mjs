import assert from "node:assert/strict";
import {
  canonicalProductCreateIdentity,
  classifyProductCreateConfirmation,
  createProductSaveSingleFlightGuard,
  runProductCreateWithConfirmation,
  runProductPostSaveTasks,
} from "../src/lib/product-create-hardening.ts";

const attempted = [];
const diagnostics = [];
const result = await runProductPostSaveTasks([
  { stage: "asset_cleanup", run: () => attempted.push("asset_cleanup"), onFailure: () => undefined },
  { stage: "audit", run: () => { attempted.push("audit"); throw new Error("synthetic audit failure"); }, onFailure: () => diagnostics.push("audit") },
  { stage: "cache_revalidation", run: () => { attempted.push("cache_revalidation"); throw new Error("synthetic revalidation failure"); }, onFailure: () => { diagnostics.push("cache_revalidation"); throw new Error("synthetic diagnostic failure"); } },
]);
assert.deepEqual(attempted, ["asset_cleanup", "audit", "cache_revalidation"]);
assert.deepEqual(result.failedStages, ["audit", "cache_revalidation"]);
assert.deepEqual(diagnostics, ["audit", "cache_revalidation"]);

const guard = createProductSaveSingleFlightGuard();
assert.equal(guard.tryStart(), true);
assert.equal(guard.tryStart(), false, "a double submit must be rejected while the first is active");
guard.finish();
assert.equal(guard.tryStart(), true, "a corrected retry is allowed after the first attempt settles");
guard.finish();

const identity = { id: "11111111-1111-4111-8111-111111111111", sku: "ALF-5D-HILUX", slug: "alfombra-5d-hilux-doble-cabina" };
assert.deepEqual(
  canonicalProductCreateIdentity({ sku: " alf-5d-hilux ", slug: "", name: "Alfombra 5D Hilux Doble Cabina" }),
  { sku: "ALF-5D-HILUX", slug: "alf-5d-hilux-alfombra-5d-hilux-doble-cabina" },
);
assert.deepEqual(
  canonicalProductCreateIdentity({ sku: " alf-5d-hilux ", slug: "alfombra-5d-hilux-doble-cabina", name: "ignored" }),
  { sku: "ALF-5D-HILUX", slug: "alfombra-5d-hilux-doble-cabina" },
);
assert.deepEqual(classifyProductCreateConfirmation([], []), { status: "not_found" });
assert.deepEqual(classifyProductCreateConfirmation([identity], [identity]), { status: "confirmed", productId: identity.id });
assert.deepEqual(
  classifyProductCreateConfirmation([identity], [{ ...identity, id: "22222222-2222-4222-8222-222222222222" }]),
  { status: "conflict" },
);

const created = { ok: true, code: "PRODUCT_CREATED", message: "created" };
const refreshPending = { ok: true, code: "PRODUCT_SAVED_REFRESH_PENDING", message: "created; refresh pending" };
const validationFailed = { ok: false, code: "VALIDATION_FAILED", message: "invalid" };
const unconfirmed = { ok: false, code: "PRODUCT_WRITE_UNCONFIRMED", message: "unknown" };
const confirmed = { ok: true, code: "PRODUCT_CREATED_CONFIRMED", message: "confirmed" };
const notCreated = { ok: false, code: "PRODUCT_NOT_CREATED", message: "not created" };
let confirmationCalls = 0;

assert.deepEqual(
  await runProductCreateWithConfirmation(async () => created, async () => {
    confirmationCalls += 1;
    return confirmed;
  }),
  created,
  "normal committed success remains authoritative",
);
assert.equal(confirmationCalls, 0);

assert.deepEqual(
  await runProductCreateWithConfirmation(async () => refreshPending, async () => {
    confirmationCalls += 1;
    return confirmed;
  }),
  refreshPending,
  "a post-save refresh warning must preserve committed success",
);
assert.equal(confirmationCalls, 0);

assert.deepEqual(
  await runProductCreateWithConfirmation(async () => validationFailed, async () => {
    confirmationCalls += 1;
    return confirmed;
  }),
  validationFailed,
  "a deterministic pre-commit failure must not be reclassified",
);
assert.equal(confirmationCalls, 0);

assert.deepEqual(
  await runProductCreateWithConfirmation(async () => unconfirmed, async () => confirmed),
  confirmed,
  "an ambiguous RPC response must use canonical confirmation",
);
assert.deepEqual(
  await runProductCreateWithConfirmation(async () => { throw new Error("lost response"); }, async () => confirmed),
  confirmed,
  "a lost response after commit must resolve to the canonical product",
);
assert.deepEqual(
  await runProductCreateWithConfirmation(async () => { throw new Error("request not sent"); }, async () => notCreated),
  notCreated,
  "a transport failure before commit must resolve to a safe retry result",
);

console.log("product create hardening unit scenarios: PASS");
