import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(url)) {
  throw new Error("This visual fixture may run only against local Supabase.");
}
if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const marker = "customer-merge-visual";
await admin.from("roles").upsert([
  { name: "vendedor", description: "Rol sintético de vendedor", permissions: ["admin:access", "products:read", "orders:read", "customers:read", "customers:manage", "crm:manage"] },
  { name: "contadora", description: "Rol sintético de contadora", permissions: ["admin:access", "orders:read", "customers:read", "payments:read", "invoices:read", "invoices:create", "fiscal:read", "settings:fiscal", "credit:read", "credit:mark_paid", "accounting:read", "accounting:manage"] },
  { name: "cliente", description: "Rol sintético de cliente", permissions: ["store:buy", "orders:read_own", "invoices:read_own"] },
], { onConflict: "name" });
const cleanupCustomerIds = ["da100000-0000-4000-8000-000000000001", "da100000-0000-4000-8000-000000000002", "da100000-0000-4000-8000-000000000003", "da100000-0000-4000-8000-000000000004", "da100000-0000-4000-8000-000000000005", "da100000-0000-4000-8000-000000000006"];
for (const [table, column] of [["accounts_receivable_payments", "customer_id"], ["accounts_receivable", "customer_id"], ["payments", "customer_id"], ["invoices", "customer_id"], ["orders", "customer_id"], ["customer_credit_accounts", "customer_id"], ["crm_followups", "customer_id"], ["crm_notes", "customer_id"]]) {
  const { error } = await admin.from(table).delete().in(column, cleanupCustomerIds);
  if (error) throw error;
}
const { error: cleanupCustomersError } = await admin.from("customers").delete().in("id", cleanupCustomerIds);
if (cleanupCustomersError) throw cleanupCustomersError;
const password = "CustomerMerge-Visual-2026!";
const accounts = [
  { key: "owner", email: "customer-merge-owner@example.test", name: "Propietario técnico visual", role: "technical_owner" },
  { key: "seller", email: "customer-merge-seller@example.test", name: "Vendedor visual", role: "vendedor" },
  { key: "accountant", email: "customer-merge-accountant@example.test", name: "Contadora visual", role: "contadora" },
  { key: "portal", email: "customer-merge-portal@example.test", name: "Cliente portal visual", role: "cliente" },
  { key: "portalA", email: "customer-merge-portal-a@example.test", name: "Portal A visual", role: "cliente" },
  { key: "portalB", email: "customer-merge-portal-b@example.test", name: "Portal B visual", role: "cliente" },
];

const { data: authPage, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (listError) throw listError;
for (const user of authPage.users.filter((candidate) => accounts.some((account) => account.email === candidate.email))) {
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) throw error;
}

const roleRows = new Map();
for (const roleName of [...new Set(accounts.map((account) => account.role))]) {
  const { data, error } = await admin.from("roles").select("id").eq("name", roleName).single();
  if (error) throw error;
  roleRows.set(roleName, data.id);
}

const users = new Map();
for (const account of accounts) {
  const { data, error } = await admin.auth.admin.createUser({
    email: account.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: account.name },
  });
  if (error) throw error;
  const { error: roleError } = await admin.from("users").update({ role_id: roleRows.get(account.role), full_name: account.name }).eq("id", data.user.id);
  if (roleError) throw roleError;
  users.set(account.key, data.user.id);
}

const ids = {
  primary: "da100000-0000-4000-8000-000000000001",
  secondary: "da100000-0000-4000-8000-000000000002",
  fiscalPrimary: "da100000-0000-4000-8000-000000000003",
  fiscalSecondary: "da100000-0000-4000-8000-000000000004",
  portalPrimary: "da100000-0000-4000-8000-000000000005",
  portalSecondary: "da100000-0000-4000-8000-000000000006",
  order: "da200000-0000-4000-8000-000000000001",
  invoice: "da300000-0000-4000-8000-000000000001",
  payment: "da400000-0000-4000-8000-000000000001",
  receivable: "da500000-0000-4000-8000-000000000001",
  receivablePayment: "da600000-0000-4000-8000-000000000001",
};
const now = new Date().toISOString();
const old = new Date(Date.now() - 86400000).toISOString();
const { error: customersError } = await admin.from("customers").insert([
  { id: ids.primary, user_id: users.get("portal"), business_name: "Repuestos Integrales Visual", company_name: "Repuestos Integrales Visual, S. de R.L.", contact_name: "Ana Mejía", email: "customer-merge-portal@example.test", phone: "+50499887766", tax_id: "08011999111111", address: "Boulevard Morazán", city: "Tegucigalpa", source: marker, status: "active", active: true, lead_status: "cliente", is_wholesale: true, wholesale_status: "approved", wholesale_customer_type: "existing", wholesale_approved_at: old, created_at: old },
  { id: ids.secondary, business_name: "Repuestos Integrales HN", contact_name: "Ana Lucía Mejía", email: "CUSTOMER-MERGE-PORTAL@example.test", phone: "9988-7766", tax_id: "05011999111111", address: "Colonia Palmira", city: "Distrito Central", source: marker, status: "active", active: true, lead_status: "cliente", is_wholesale: false, wholesale_status: "none", wholesale_customer_type: "new", created_at: now },
  { id: ids.fiscalPrimary, business_name: "Fiscal Visual Centro", contact_name: "Carlos Díaz", email: "fiscal.visual@example.test", phone: "9977-6655", tax_id: "08011999222222", source: marker, is_wholesale: false, wholesale_status: "none", wholesale_customer_type: "new", status: "active", active: true, lead_status: "cliente", created_at: old },
  { id: ids.fiscalSecondary, business_name: "Fiscal Visual Centro HN", contact_name: "Carlos Díaz", email: "FISCAL.VISUAL@example.test", phone: "+50499776655", tax_id: "05011999333333", source: marker, is_wholesale: false, wholesale_status: "none", wholesale_customer_type: "new", status: "active", active: true, lead_status: "cliente", created_at: now },
  { id: ids.portalPrimary, user_id: users.get("portalA"), business_name: "Portales Duales Visual", contact_name: "Portal A", email: "portales.duales@example.test", phone: "9966-5544", source: marker, is_wholesale: false, wholesale_status: "none", wholesale_customer_type: "new", status: "active", active: true, lead_status: "cliente", created_at: old },
  { id: ids.portalSecondary, user_id: users.get("portalB"), business_name: "Portales Duales Visual HN", contact_name: "Portal B", email: "PORTALES.DUALES@example.test", phone: "+50499665544", source: marker, is_wholesale: false, wholesale_status: "none", wholesale_customer_type: "new", status: "active", active: true, lead_status: "cliente", created_at: now },
]);
if (customersError) throw customersError;

const { error: noteError } = await admin.from("crm_notes").insert({ customer_id: ids.secondary, note: "Historial sintético trasladable para la validación integral.", user_id: users.get("owner") });
if (noteError) throw noteError;
const { error: followupError } = await admin.from("crm_followups").insert({ customer_id: ids.secondary, title: "Seguimiento sintético pendiente", status: "pending", assigned_user_id: users.get("seller"), due_at: new Date(Date.now() + 86400000).toISOString() });
if (followupError) throw followupError;

const { error: creditError } = await admin.from("customer_credit_accounts").insert([
  { customer_id: ids.primary, is_credit_enabled: true, credit_limit: 12000, terms_days: 30, status: "active", activated_at: old, activated_by: users.get("owner"), notes: "Crédito sintético primario" },
  { customer_id: ids.secondary, is_credit_enabled: true, credit_limit: 8000, terms_days: 15, status: "active", activated_at: now, activated_by: users.get("owner"), notes: "Crédito sintético secundario" },
]);
if (creditError) throw creditError;

const { error: orderError } = await admin.from("orders").insert({ id: ids.order, order_number: "VISUAL-MERGE-001", customer_id: ids.secondary, customer_name: "Repuestos Integrales HN", email: "CUSTOMER-MERGE-PORTAL@example.test", phone: "9988-7766", customer_phone: "9988-7766", delivery_address: "Colonia Palmira", payment_method: "commercial_credit", payment_timing: "on_delivery", price_mode: "wholesale", subtotal: 2000, tax: 300, total: 2300, status: "delivered", source: "pos", channel: "store", created_by: users.get("seller"), seller_id: users.get("seller") });
if (orderError) throw orderError;
const { error: invoiceError } = await admin.from("invoices").insert({ id: ids.invoice, order_id: ids.order, customer_id: ids.secondary, invoice_number: "000-001-01-99000001", customer_name: "Repuestos Integrales HN", customer_rtn: "05011999111111", customer_phone: "9988-7766", customer_email: "CUSTOMER-MERGE-PORTAL@example.test", customer_address: "Colonia Palmira", status: "issued", price_mode: "wholesale", subtotal: 2000, tax: 300, total: 2300, issued_at: now, invoice_date: new Date().toISOString().slice(0,10) });
if (invoiceError) throw invoiceError;
const { error: paymentError } = await admin.from("payments").insert({ id: ids.payment, order_id: ids.order, customer_id: ids.secondary, method: "commercial_credit", payment_method: "commercial_credit", status: "approved", payment_status: "approved", payment_timing: "on_delivery", amount: 500, reference: "VISUAL-PAYMENT", paid_at: now, confirmed_by: users.get("accountant") });
if (paymentError) throw paymentError;

const { error: receivableError } = await admin.from("accounts_receivable").insert({ id: ids.receivable, customer_id: ids.secondary, order_id: ids.order, invoice_id: ids.invoice, original_amount: 2300, balance_due: 1800, due_date: new Date(Date.now() + 2592000000).toISOString().slice(0,10), status: "partial", historical_invoice_number: "000-001-01-99000001" });
if (receivableError) throw receivableError;
const { error: receivablePaymentError } = await admin.from("accounts_receivable_payments").insert({ id: ids.receivablePayment, receivable_id: ids.receivable, customer_id: ids.secondary, order_id: ids.order, amount: 500, payment_method: "cash", reference: "VISUAL-CXC-ABONO", recorded_by: users.get("accountant"), balance_before: 2300, balance_after: 1800 });
if (receivablePaymentError) throw receivablePaymentError;

const { error: flagError } = await admin.from("customer_feature_flags").update({ enabled: true, enabled_at: now, updated_by: users.get("owner") }).in("key", ["customer_duplicate_prevention_v1", "customer_merge_execution_v1"]);
if (flagError) throw flagError;

console.log(JSON.stringify({ password, emails: Object.fromEntries(accounts.map((account) => [account.key, account.email])), users: Object.fromEntries(users), ids }, null, 2));
