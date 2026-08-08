import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import {
  assertStage6LocalEnvironment,
  readStage6LocalStatus,
} from "./pos-stage-6-local-guard.mjs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
}

const marker = process.env.POS_TEST_MARKER_PREFIX ?? "POS-INVENTORY-VISIBILITY-LOCAL-ONLY";
assert.equal(marker, "POS-INVENTORY-VISIBILITY-LOCAL-ONLY");
const environment = assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const password = `Cz-${randomUUID()}!a9`;
const email = `pos-inventory-${Date.now()}@example.test`;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Tegucigalpa",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const inventoryRaceAdvisoryKey = 8_080_800_2;

function sql(query) {
  return execFileSync("docker", [
    "exec", environment.container, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-qAt", "-c", query,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForBlockedCall(functionName, minimumCount, earlyOutcome, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (earlyOutcome?.settled) {
      throw new Error(`${functionName} settled before reaching the controlled product lock: ${JSON.stringify(earlyOutcome.value)}`);
    }
    const count = Number(sql(`
      select count(*)
      from pg_stat_activity
      where wait_event_type = 'Lock'
        and datname = current_database()
        and usename = 'authenticator';
    `));
    if (count >= minimumCount) {
      const queues = sql(`
        select coalesce(jsonb_agg(jsonb_build_object(
          'wait', wait_event, 'query', left(query, 200)
        ) order by query), '[]'::jsonb)
        from pg_stat_activity
        where wait_event_type='Lock' and datname=current_database() and usename='authenticator';
      `);
      console.log(`Controlled lock queue (${functionName}, ${minimumCount}): ${queues}`);
      return;
    }
    await delay(50);
  }
  const diagnostic = sql(`
    select coalesce(jsonb_agg(jsonb_build_object(
      'user', usename, 'state', state, 'waitType', wait_event_type,
      'wait', wait_event, 'query', left(query, 160)
    )), '[]'::jsonb)
    from pg_stat_activity
    where datname=current_database() and pid<>pg_backend_pid();
  `);
  throw new Error(`Timed out waiting for ${minimumCount} blocked ${functionName} call(s): ${diagnostic}`);
}

function lockInventoryRace() {
  const token = `GATE-${randomUUID()}`;
  const child = spawn("docker", [
    "exec", "-i", environment.container, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-qAt",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errorOutput = "";
  let resolved = false;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (!resolved && output.includes(token)) {
        resolved = true;
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
    child.once("exit", (code) => {
      if (!resolved) reject(new Error(`Product gate exited ${code}: ${errorOutput}`));
    });
  });
  child.once("error", (error) => rejectReady(error));
  child.stdin.write(`begin;\nselect pg_advisory_xact_lock(${inventoryRaceAdvisoryKey});\nselect '${token}';\n`);
  return {
    ready,
    async release() {
      const exited = new Promise((resolve, reject) => {
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Gate commit failed (${code}): ${errorOutput}`)));
      });
      child.stdin.end("commit;\n\\q\n");
      await exited;
    },
  };
}

async function orderedRace({ productId, first, firstFunction, second, secondFunction }) {
  assert.ok(productId, "A product is required for the controlled race.");
  const gate = lockInventoryRace();
  await gate.ready;
  const firstOutcome = { settled: false, value: null };
  const firstPromise = Promise.resolve(first());
  firstPromise.then((value) => { firstOutcome.settled = true; firstOutcome.value = value; });
  await waitForBlockedCall(firstFunction, 1, firstOutcome);
  const secondOutcome = { settled: false, value: null };
  const secondPromise = Promise.resolve(second());
  secondPromise.then((value) => { secondOutcome.settled = true; secondOutcome.value = value; });
  await waitForBlockedCall(secondFunction, 2, secondOutcome);
  await gate.release();
  return Promise.all([firstPromise, secondPromise]);
}

function errorCode(result) {
  return result.error?.message ?? result.error?.code ?? null;
}

async function assertReconciled(productId, expected) {
  const productResult = await admin.from("products")
    .select("stock,reserved_stock,available_stock")
    .eq("id", productId)
    .single();
  assert.ifError(productResult.error);
  const reservationsResult = await admin.from("inventory_reservations")
    .select("quantity")
    .eq("product_id", productId)
    .eq("status", "reserved");
  assert.ifError(reservationsResult.error);
  const ledgerReserved = reservationsResult.data.reduce((total, row) => total + row.quantity, 0);
  assert.equal(productResult.data.reserved_stock, ledgerReserved, "reserved_stock must equal the active ledger");
  assert.deepEqual(productResult.data, expected);
}

const userResult = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: marker },
});
assert.ifError(userResult.error);
const userId = userResult.data.user.id;
const permissions = [
  "pos:create_sale", "pos:access", "pos:customers:search", "customers:read_commercial",
  "customers:read_credit", "pos:drafts:create", "pos:drafts:read", "pos:drafts:edit_own",
  "pos:drafts:edit_any", "pos:drafts:abandon", "pos:products:search", "pos:price_override",
  "pos:confirm_sale", "pos:reprint_documents", "invoices:create", "settings:fiscal",
  "orders:read",
];
const roleResult = await admin.from("roles").upsert({
  name: "admin",
  description: marker,
  permissions,
}, { onConflict: "name" }).select("id").single();
assert.ifError(roleResult.error);
assert.ifError((await admin.from("users").update({ role_id: roleResult.data.id, active: true }).eq("id", userId)).error);

const posClient = createClient(status.API_URL, status.ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
assert.ifError((await posClient.auth.signInWithPassword({ email, password })).error);
const customerResult = await admin.from("customers").insert({
  contact_name: marker,
  email,
  phone: "99995555",
  address: "Tegucigalpa",
  city: "Tegucigalpa",
  source: "pos",
  lead_status: "cliente",
  status: "active",
  active: true,
}).select("id,commercial_version").single();
assert.ifError(customerResult.error);
const customer = customerResult.data;
const categoryResult = await admin.from("categories").select("id").eq("active", true).limit(1).single();
assert.ifError(categoryResult.error);

assert.ifError((await admin.from("checkout_feature_flags").update({
  enabled: true,
  enabled_at: new Date().toISOString(),
}).eq("key", "checkout_order_v4")).error);
assert.ifError((await admin.from("company_settings").insert({
  id: randomUUID(),
  company_name: marker,
  currency: "HNL",
  wholesale_purchases_enabled: true,
  allow_bank_transfer: true,
  allow_cash_on_delivery: true,
  tax_rate: 0.15,
  invoice_prefix: "POSIV",
  order_prefix: "POSIV",
  free_shipping_threshold: 3000,
  standard_shipping_fee: 120,
  first_wholesale_minimum: 10000,
})).error);
assert.ifError((await posClient.from("fiscal_settings").update({
  legal_name: marker,
  rtn: "08011999123456",
  cai: `${marker}-CAI`,
  cai_authorization_date: "2026-01-01",
  invoice_range_start: "000-001-01-00000001",
  invoice_range_end: "000-001-01-00000999",
  current_invoice_number: "000-001-01-00000001",
  emission_deadline: "2026-12-31",
  fiscal_address: "Tegucigalpa",
  phone: "99990000",
  email,
}).eq("id", true)).error);

// This trigger exists only in the disposable local test database. It pauses the
// first inventory mutation after that transaction owns the product row, so the
// competing request can be observed waiting behind it. It is never migrated.
sql(`
  create or replace function public.pos_inventory_visibility_local_gate()
  returns trigger
  language plpgsql
  as $$
  begin
    if new.description = '${marker}'
       and (new.stock is distinct from old.stock
            or new.reserved_stock is distinct from old.reserved_stock) then
      perform pg_advisory_xact_lock(${inventoryRaceAdvisoryKey});
    end if;
    return new;
  end;
  $$;
  drop trigger if exists pos_inventory_visibility_local_gate on public.products;
  create trigger pos_inventory_visibility_local_gate
  before update of stock, reserved_stock on public.products
  for each row execute function public.pos_inventory_visibility_local_gate();
`);

async function createProduct(label) {
  const result = await admin.from("products").insert({
    category_id: categoryResult.data.id,
    sku: `${marker}-${label}-${randomUUID().slice(0, 8)}`,
    internal_code: `${label}-${randomUUID().slice(0, 8)}`,
    slug: `${marker}-${label}-${randomUUID()}`.toLowerCase(),
    name: `${marker} ${label}`,
    brand: "TEST",
    description: marker,
    stock: 1,
    reserved_stock: 0,
    retail_price: 115,
    wholesale_price: 100,
    wholesale_min_quantity: 2,
    cost_price: 50,
    tax_category: "standard",
    tracks_inventory: true,
    status: "active",
    active: true,
  }).select("id,product_sales_version").single();
  assert.ifError(result.error);
  return result.data;
}

async function createPosDraft(product) {
  const created = await posClient.rpc("create_selectable_pos_sale_draft_v1", {
    p_request_key: randomUUID(),
    p_customer_id: customer.id,
  });
  assert.ifError(created.error);
  const saved = await posClient.rpc("save_pos_sale_draft_with_charge_descriptions_v1", {
    p_request_key: randomUUID(),
    p_draft_id: created.data.draftId,
    p_expected_version: created.data.version,
    p_customer_id: customer.id,
    p_expected_customer_commercial_version: customer.commercial_version,
    p_items: [{
      productId: product.id,
      quantity: 1,
      finalUnitPrice: null,
      priceOverrideReason: null,
      expectedProductSalesVersion: product.product_sales_version,
    }],
    p_delivery_mode: "store_immediate",
    p_delivery_address: null,
    p_delivery_notes: null,
    p_internal_notes: marker,
    p_delivery_charge: 0,
    p_cash_on_delivery_charge: 0,
    p_additional_charge: 0,
    p_other_charge: 0,
    p_additional_charge_description: null,
    p_other_charge_description: null,
  });
  assert.ifError(saved.error);
  return saved.data;
}

function confirmPos(draft) {
  return posClient.rpc("confirm_pos_sale_with_charge_descriptions_v1", {
    p_draft_id: draft.draftId,
    p_request_key: randomUUID(),
    p_expected_draft_version: draft.version,
    p_invoice_date: today,
    p_payment_payload: { method: "cash", amount_tendered: 115 },
  });
}

async function prepareCheckout(productId, label) {
  const requestKey = randomUUID();
  const recoveryToken = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  const checkoutEmail = `${label}-${requestKey}@example.test`;
  const cartItems = [{ product_id: productId, variant_id: null, quantity: 1 }];
  const customerData = {
    name: `${marker} ${label}`,
    email: checkoutEmail,
    phone: "99990009",
    rtn: null,
    email_updates_opt_in: true,
    bank_reference: `${marker}-${label}`,
  };
  const deliveryData = {
    country: "Honduras",
    country_code: "HN",
    department: "Francisco Morazan",
    city: "Tegucigalpa",
    address: marker,
    mode: "home_delivery",
  };
  const context = await admin.rpc("resolve_portal_commercial_context_v2", { p_guest_intent: true });
  assert.ifError(context.error);
  const cart = await admin.rpc("resolve_checkout_cart_v4", { p_cart_items: cartItems, p_guest_intent: true });
  assert.ifError(cart.error);
  const begun = await admin.rpc("begin_checkout_request_v1", {
    p_request_key: requestKey,
    p_recovery_token: recoveryToken,
    p_expected_actor_scope: "guest",
    p_expected_context_token: context.data.contextToken,
    p_expected_commercial_version: null,
    p_cart_fingerprint: cart.data.cartFingerprint,
    p_cart_items: cartItems,
    p_customer_data: customerData,
    p_delivery_data: deliveryData,
    p_payment_method: "bank_transfer",
    p_payment_timing: "before_delivery",
  });
  assert.ifError(begun.error);
  const args = {
    p_request_key: requestKey,
    p_request_fingerprint: begun.data.requestFingerprint,
    p_expected_context_token: context.data.contextToken,
    p_expected_commercial_version: null,
    p_cart_fingerprint: cart.data.cartFingerprint,
    p_cart_items: cartItems,
    p_customer_data: customerData,
    p_delivery_data: deliveryData,
    p_payment_method: "bank_transfer",
    p_payment_timing: "before_delivery",
    p_payment_data: { bank_reference: `${marker}-${label}` },
  };
  return {
    requestKey,
    recoveryToken,
    requestFingerprint: begun.data.requestFingerprint,
    checkoutEmail,
    call: () => admin.rpc("create_checkout_order_v4", args),
    async markFailed(code) {
      const result = await admin.rpc("mark_checkout_request_failed_v1", {
        p_request_key: requestKey,
        p_request_fingerprint: begun.data.requestFingerprint,
        p_recovery_token: recoveryToken,
        p_error_code: code,
        p_retryable: true,
      });
      assert.ifError(result.error);
    },
  };
}

async function assertNoPosArtifacts(draftId) {
  const draftResult = await admin.from("pos_sale_drafts")
    .select("status,order_id,invoice_id,payment_id,receivable_id")
    .eq("id", draftId)
    .single();
  assert.ifError(draftResult.error);
  assert.equal(draftResult.data.status, "active");
  assert.equal(draftResult.data.order_id, null);
  assert.equal(draftResult.data.invoice_id, null);
  assert.equal(draftResult.data.payment_id, null);
  assert.equal(draftResult.data.receivable_id, null);
  assert.equal(Number(sql(`select count(*) from public.orders where pos_draft_id='${draftId}';`)), 0);
}

async function assertWebOrderCount(checkoutEmail, expected) {
  const result = await admin.from("orders").select("id").eq("email", checkoutEmail);
  assert.ifError(result.error);
  assert.equal(result.data.length, expected);
  return result.data[0]?.id ?? null;
}

const webWinsProduct = await createProduct("WEB-WINS");
const webWinsDraft = await createPosDraft(webWinsProduct);
const webWinner = await prepareCheckout(webWinsProduct.id, "web-wins");
const [webWin, posLoss] = await orderedRace({
  productId: webWinsProduct.id,
  first: webWinner.call,
  firstFunction: "create_checkout_order_v4",
  second: () => confirmPos(webWinsDraft),
  secondFunction: "confirm_pos_sale_with_charge_descriptions_v1",
});
assert.ifError(webWin.error);
assert.ok(
  ["POS_INSUFFICIENT_STOCK", "POS_PRODUCT_INACTIVE"].includes(errorCode(posLoss)),
  `Unexpected POS inventory conflict: ${errorCode(posLoss)}`,
);
await assertNoPosArtifacts(webWinsDraft.draftId);
assert.ok(await assertWebOrderCount(webWinner.checkoutEmail, 1));
await assertReconciled(webWinsProduct.id, { stock: 1, reserved_stock: 1, available_stock: 0 });

const posWinsProduct = await createProduct("POS-WINS");
const posWinsDraft = await createPosDraft(posWinsProduct);
const webLoser = await prepareCheckout(posWinsProduct.id, "pos-wins");
const [posWin, webLoss] = await orderedRace({
  productId: posWinsProduct.id,
  first: () => confirmPos(posWinsDraft),
  firstFunction: "confirm_pos_sale_with_charge_descriptions_v1",
  second: webLoser.call,
  secondFunction: "create_checkout_order_v4",
});
assert.ifError(posWin.error);
assert.ok(
  ["CHECKOUT_STOCK_CHANGED", "CHECKOUT_PRODUCT_UNAVAILABLE"].includes(errorCode(webLoss)),
  `Unexpected checkout inventory conflict: ${errorCode(webLoss)}`,
);
await webLoser.markFailed(errorCode(webLoss));
assert.equal(await assertWebOrderCount(webLoser.checkoutEmail, 0), null);
const confirmedDraft = await admin.from("pos_sale_drafts")
  .select("status,order_id,invoice_id,payment_id")
  .eq("id", posWinsDraft.draftId)
  .single();
assert.ifError(confirmedDraft.error);
assert.equal(confirmedDraft.data.status, "confirmed");
assert.ok(confirmedDraft.data.order_id && confirmedDraft.data.invoice_id && confirmedDraft.data.payment_id);
await assertReconciled(posWinsProduct.id, { stock: 0, reserved_stock: 0, available_stock: 0 });

const webWebProduct = await createProduct("WEB-WEB");
const checkoutA = await prepareCheckout(webWebProduct.id, "web-web-a");
const checkoutB = await prepareCheckout(webWebProduct.id, "web-web-b");
assert.notEqual(checkoutA.requestKey, checkoutB.requestKey);
const [webA, webB] = await orderedRace({
  productId: webWebProduct.id,
  first: checkoutA.call,
  firstFunction: "create_checkout_order_v4",
  second: checkoutB.call,
  secondFunction: "create_checkout_order_v4",
});
assert.ifError(webA.error);
assert.ok(
  ["CHECKOUT_STOCK_CHANGED", "CHECKOUT_PRODUCT_UNAVAILABLE"].includes(errorCode(webB)),
  `Unexpected checkout inventory conflict: ${errorCode(webB)}`,
);
await checkoutB.markFailed(errorCode(webB));
assert.ok(await assertWebOrderCount(checkoutA.checkoutEmail, 1));
assert.equal(await assertWebOrderCount(checkoutB.checkoutEmail, 0), null);
await assertReconciled(webWebProduct.id, { stock: 1, reserved_stock: 1, available_stock: 0 });
assert.equal(Number(sql(`
  select count(*) from public.inventory_reservations
  where product_id='${webWebProduct.id}' and status='reserved';
`)), 1);

sql(`
  drop trigger if exists pos_inventory_visibility_local_gate on public.products;
  drop function if exists public.pos_inventory_visibility_local_gate();
`);

console.log("POS inventory concurrency: PASS", {
  gate: "local advisory gate + verified product-row wait queue",
  webThenPos: `web committed; ${errorCode(posLoss)}`,
  posThenWeb: `POS committed; ${errorCode(webLoss)}`,
  webThenWebDifferentKeys: `one committed; one ${errorCode(webB)}`,
  reservedStockReconciled: true,
  marker,
});
