import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const container = process.env.LOCAL_PG_DOCKER_CONTAINER ?? "supabase_db_car-zone-accesorios";
const allowedContainers = new Set(["supabase_db_car-zone-accesorios", "car-zone-schema-validation-local"]);

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required for the disposable local DB test.");
}
if (!allowedContainers.has(container) || container.includes("supabase.co")) {
  throw new Error("Only an approved local PostgreSQL container is allowed.");
}

const ids = {
  supplier: randomUUID(),
  product: randomUUID(),
  directPurchase: randomUUID(),
};
const prefix = `TEST-PURCHASE-STOCK-${Date.now()}`;

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"],
    { input: sql, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
  ).trim();
}

async function psqlAsync(sql) {
  const { stdout } = await execFileAsync(
    "docker",
    ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
  );
  return stdout.trim();
}

function serviceSession(statement) {
  return `
    begin;
    set local role authenticated;
    select set_config('request.jwt.claim.role', 'service_role', true);
    select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
    ${statement}
    commit;
  `;
}

function savePurchaseSql({ purchaseId = null, purchaseNumber, quantity, duplicateItemId = null }) {
  const item = (id) => `jsonb_build_object(
    'id', ${id ? `'${id}'` : "null"},
    'product_id', '${ids.product}',
    'description', '${prefix}',
    'quantity', ${quantity},
    'unit_cost', 10,
    'tax_amount', 3,
    'discount_amount', 1,
    'total_cost', 9999
  )`;
  const items = duplicateItemId
    ? `jsonb_build_array(${item(duplicateItemId)}, ${item(duplicateItemId)})`
    : `jsonb_build_array(${item(null)})`;
  return `
    select purchase_id
    from public.save_purchase_with_inventory(
      ${purchaseId ? `'${purchaseId}'::uuid` : "null::uuid"},
      jsonb_build_object(
        'supplier_id', '${ids.supplier}',
        'purchase_number', '${purchaseNumber}',
        'purchase_date', current_date,
        'subtotal', 9999,
        'tax_amount', 9999,
        'discount_amount', 9999,
        'shipping_amount', 4,
        'total', 9999,
        'currency', 'HNL'
      ),
      ${items}
    );
  `;
}

function expectReject(label, sql, pattern) {
  try {
    psql(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern) assert.match(message, pattern, label);
    return;
  }
  throw new Error(`Expected rejection did not occur: ${label}`);
}

function cleanup() {
  psql(`
    delete from public.audit_logs
    where new_data::text like '%${prefix}%'
      or old_data::text like '%${prefix}%'
      or record_id = '${ids.product}'::uuid
      or new_data->>'reference_id' in (select id::text from public.purchases where purchase_number like '${prefix}%');
    delete from public.inventory_movements where reference_id in (select id from public.purchases where purchase_number like '${prefix}%');
    delete from public.purchase_items where purchase_id in (select id from public.purchases where purchase_number like '${prefix}%');
    delete from public.purchases where purchase_number like '${prefix}%';
    delete from public.products where id = '${ids.product}'::uuid;
    delete from public.suppliers where id = '${ids.supplier}'::uuid;
  `);
}

try {
  cleanup();
  psql(`
    insert into public.suppliers (id, name, is_active) values ('${ids.supplier}', '${prefix}', true);
    insert into public.products (id, sku, slug, name, brand, stock, retail_price, wholesale_price, cost_price, active, status)
    values ('${ids.product}', '${prefix}', '${prefix.toLowerCase()}', '${prefix}', 'TEST', 5, 100, 80, 10, true, 'active');
  `);

  psql(`update public.products set active=false where id='${ids.product}';`);
  assert.equal(psql(`select active::text || '|' || status from public.products where id='${ids.product}';`), "false|inactive");
  expectReject(
    "contradictory product state",
    `update public.products set active=true, status='archived' where id='${ids.product}';`,
    /deben coincidir/i,
  );
  psql(`update public.products set status='active' where id='${ids.product}';`);
  assert.equal(psql(`select active::text || '|' || status from public.products where id='${ids.product}';`), "true|active");

  expectReject(
    "direct purchase insert",
    `begin; set local role authenticated; insert into public.purchases (id, supplier_id, purchase_number) values ('${ids.directPurchase}', '${ids.supplier}', '${prefix}-DIRECT'); commit;`,
    /permission denied/i,
  );

  const firstNumber = `${prefix}-001`;
  psql(serviceSession(savePurchaseSql({ purchaseNumber: firstNumber, quantity: 2 })));
  const firstPurchase = JSON.parse(psql(`
    select jsonb_build_object(
      'id', purchases.id,
      'stock', (select stock from public.products where id='${ids.product}'),
      'subtotal', purchases.subtotal,
      'tax', purchases.tax_amount,
      'discount', purchases.discount_amount,
      'shipping', purchases.shipping_amount,
      'total', purchases.total,
      'lineTotal', (select total_cost from public.purchase_items where purchase_id=purchases.id limit 1)
    )
    from public.purchases where purchase_number='${firstNumber}';
  `));
  assert.deepEqual(firstPurchase, { id: firstPurchase.id, stock: 7, subtotal: 20, tax: 3, discount: 1, shipping: 4, total: 26, lineTotal: 22 });

  const itemId = psql(`select id from public.purchase_items where purchase_id='${firstPurchase.id}' limit 1;`);
  const beforeDuplicate = psql(`select stock || '|' || (select count(*) from public.inventory_movements where reference_id='${firstPurchase.id}') from public.products where id='${ids.product}';`);
  expectReject(
    "duplicate line ids",
    serviceSession(savePurchaseSql({ purchaseId: firstPurchase.id, purchaseNumber: firstNumber, quantity: 2, duplicateItemId: itemId })),
    /IDs de lineas duplicados/i,
  );
  const afterDuplicate = psql(`select stock || '|' || (select count(*) from public.inventory_movements where reference_id='${firstPurchase.id}') from public.products where id='${ids.product}';`);
  assert.equal(afterDuplicate, beforeDuplicate);

  psql(serviceSession(`select purchase_id from public.cancel_purchase_with_inventory('${firstPurchase.id}');`));
  assert.equal(psql(`select products.stock || '|' || purchases.status from public.products cross join public.purchases where products.id='${ids.product}' and purchases.id='${firstPurchase.id}';`), "5|cancelled");
  assert.equal(Number(psql(`select count(*) from public.inventory_movements where reference_type='purchase_cancellation' and reference_id='${firstPurchase.id}';`)), 1);
  assert.equal(psql(`select quantity || '|' || total_cost_snapshot from public.inventory_movements where reference_type='purchase_cancellation' and reference_id='${firstPurchase.id}';`), "-2|20.00");
  expectReject(
    "second cancellation",
    serviceSession(`select purchase_id from public.cancel_purchase_with_inventory('${firstPurchase.id}');`),
    /ya fue cancelada/i,
  );

  const concurrentNumber = `${prefix}-CONCURRENT`;
  psql(serviceSession(savePurchaseSql({ purchaseNumber: concurrentNumber, quantity: 3 })));
  const concurrentPurchaseId = psql(`select id from public.purchases where purchase_number='${concurrentNumber}';`);
  const concurrentSql = serviceSession(`select purchase_id from public.cancel_purchase_with_inventory('${concurrentPurchaseId}');`);
  const concurrentResults = await Promise.allSettled([psqlAsync(concurrentSql), psqlAsync(concurrentSql)]);
  assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrentResults.filter((result) => result.status === "rejected").length, 1);
  assert.equal(psql(`select products.stock || '|' || purchases.status from public.products cross join public.purchases where products.id='${ids.product}' and purchases.id='${concurrentPurchaseId}';`), "5|cancelled");
  assert.equal(Number(psql(`select count(*) from public.inventory_movements where reference_type='purchase_cancellation' and reference_id='${concurrentPurchaseId}';`)), 1);
  assert.equal(Number(psql(`select count(*) from public.audit_logs where record_id='${concurrentPurchaseId}' and action='purchases.cancel';`)), 1);

  const confirmationNumber = `${prefix}-CONFIRM`;
  psql(serviceSession(savePurchaseSql({ purchaseNumber: confirmationNumber, quantity: 1 })));
  const confirmationPurchaseId = psql(`select id from public.purchases where purchase_number='${confirmationNumber}';`);
  const confirmationSql = serviceSession(`select purchase_id from public.confirm_purchase_locked('${confirmationPurchaseId}');`);
  const confirmationResults = await Promise.allSettled([psqlAsync(confirmationSql), psqlAsync(confirmationSql)]);
  assert.equal(confirmationResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(confirmationResults.filter((result) => result.status === "rejected").length, 1);
  assert.equal(psql(`select status from public.purchases where id='${confirmationPurchaseId}';`), "confirmed");
  assert.equal(Number(psql(`select count(*) from public.audit_logs where record_id='${confirmationPurchaseId}' and action='purchases.confirm';`)), 1);
  psql(serviceSession(`select purchase_id from public.cancel_purchase_with_inventory('${confirmationPurchaseId}');`));
  assert.equal(psql(`select stock from public.products where id='${ids.product}';`), "5");

  cleanup();
  console.log("Product stock automation local integration checks passed.");
} catch (error) {
  try {
    cleanup();
  } catch (cleanupError) {
    console.error("Local test cleanup failed:", cleanupError instanceof Error ? cleanupError.message : cleanupError);
  }
  throw error;
}
