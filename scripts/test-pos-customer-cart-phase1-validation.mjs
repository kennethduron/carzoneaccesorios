import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPosMaximumQuantity, validatePosQuantity } from "../src/lib/pos/cart-quantity.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const migration = read("supabase/migrations/202608030001_pos_customer_commercial_profile.sql");
const workspace = read("src/components/admin/pos-customer-workspace.tsx");
const cart = read("src/components/admin/pos-cart.tsx");
const pos = read("src/components/admin/pos-workspace.tsx");
const validation = read("src/lib/validation/pos-customer.ts");
const createRoute = read("src/app/api/admin/pos/customers/route.ts");
const updateRoute = read("src/app/api/admin/pos/customers/[customerId]/route.ts");

assert.equal(getPosMaximumQuantity({ tracksInventory: true, availableStock: 5.9 }), 5);
assert.equal(getPosMaximumQuantity({ tracksInventory: false, availableStock: 0 }), 9999);
assert.deepEqual(validatePosQuantity({ tracksInventory: true, availableStock: 2 }, 2), { ok: true, quantity: 2, maximum: 2 });
assert.equal(validatePosQuantity({ tracksInventory: true, availableStock: 2 }, 3).code, "POS_INSUFFICIENT_STOCK");
assert.equal(validatePosQuantity({ tracksInventory: true, availableStock: 2 }, 0).code, "POS_QUANTITY_INVALID");
assert.equal(validatePosQuantity({ tracksInventory: true, availableStock: 2 }, -1).code, "POS_QUANTITY_INVALID");
assert.equal(validatePosQuantity({ tracksInventory: true, availableStock: 2 }, 1.5).code, "POS_QUANTITY_INVALID");
assert.equal(validatePosQuantity({ tracksInventory: false, availableStock: 0 }, 20).ok, true);

for (const contract of [
  "save_pos_customer_commercial_profile_v1", "claim_pos_idempotency_v1",
  "create_pos_customer_v1", "update_pos_customer_v1",
  "grant_customer_wholesale_access_v1", "return_customer_to_retail_v1",
  "set_customer_commercial_credit", "commercial_profile_saved",
]) assert.ok(migration.includes(contract), `Missing migration contract ${contract}`);
assert.match(migration, /actor_role_name not in \('technical_owner', 'business_owner', 'admin'\)/);
assert.match(migration, /CUSTOMER_PHONE_INVALID/);
assert.match(migration, /CUSTOMER_EMAIL_INVALID/);
assert.match(migration, /CUSTOMER_RTN_INVALID/);
assert.match(migration, /possible_duplicate/);
assert.match(migration, /portalLinked/);
assert.doesNotMatch(migration, /insert\s+into\s+auth\.users/i);
assert.doesNotMatch(migration, /insert\s+into\s+public\.(orders|invoices|payments|accounts_receivable|inventory_movements)\b/i);

assert.match(workspace, /Nuevo cliente/);
assert.match(workspace, /Nombre o razón social \*/);
assert.match(workspace, /Habilitar crédito comercial/);
assert.match(workspace, /Editar configuración comercial/);
assert.match(workspace, /Minorista/);
assert.match(workspace, /Mayorista/);
assert.match(workspace, /Crear y seleccionar/);
assert.doesNotMatch(workspace, /Nuevo cliente minorista/);
assert.doesNotMatch(workspace, /Evaluar elegibilidad mayorista/);
assert.doesNotMatch(workspace, /Crédito \(solo lectura\)/);

assert.match(cart, /<Minus/);
assert.match(cart, /<Plus/);
assert.match(cart, /<Trash2/);
assert.match(cart, /Deshacer/);
assert.match(cart, /Precio manual autorizado/);
assert.match(cart, /Sin control de inventario/);
assert.match(cart, /validatePosQuantity/);
assert.match(pos, /find\(\(item\) => item\.productId === product\.productId\)/);
assert.match(pos, /Ver carrito \(\{cartUnits\}\)/);
assert.match(pos, /lg:sticky/);
assert.match(pos, /validatePosQuantity\(existing, existing\.quantity \+ 1\)/);
assert.match(pos, /const changeRevisionRef = useRef\(0\)/);
assert.match(pos, /const savingRevision = changeRevisionRef\.current/);
assert.match(pos, /changeRevisionRef\.current === savingRevision/);

for (const source of [createRoute, updateRoute]) {
  assert.match(source, /parsePosCustomerInput/);
  assert.match(source, /wholesale:manage/);
  assert.match(source, /credit:manage/);
}
assert.match(validation, /CUSTOMER_NAME_REQUIRED/);
assert.match(validation, /CUSTOMER_PHONE_INVALID/);
assert.match(validation, /CUSTOMER_EMAIL_INVALID/);
assert.match(validation, /CUSTOMER_RTN_INVALID/);
assert.match(validation, /creditTermsDays/);

console.log("POS customer and professional cart validation: 55 assertions PASS");
