import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) throw new Error("Missing Supabase production credentials.");

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ids = [
  "3548cc3e-cd22-4c08-9407-9593ee1a173b",
  "03d54a49-f7b4-431f-bd4e-5837371291c6",
  "139f3464-2350-4ab8-8e7a-b002fab4f252",
  "00dba094-ca6f-4cdb-8dae-7b363a8cc246",
  "eb94c225-e3fd-4058-89b2-6e57645f4d59",
  "255c3599-beaf-4ebf-a348-17bb625692c3",
];

async function select(label, query) {
  const { data, error, count } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return { label, count: count ?? data?.length ?? null, data };
}

const results = await Promise.all([
  select("customers", supabase.from("customers").select("id,user_id,business_name,company_name,contact_name,email,phone,tax_id,address,city,is_wholesale,wholesale_status,wholesale_customer_type,commercial_version,status,active,created_at,updated_at").in("id", ids)),
  select("orders", supabase.from("orders").select("id,order_number,tracking_code,customer_id,user_id,status,price_mode,total,created_at").or(`customer_id.in.(${ids.join(",")}),order_number.eq.CZ-260730213609-063D32`)),
  select("invoices", supabase.from("invoices").select("id,order_id,customer_id,invoice_number,status,total,issued_at,created_at").or(`customer_id.in.(${ids.join(",")}),invoice_number.eq.000-001-01-00001020`)),
  select("credit", supabase.from("customer_credit_accounts").select("id,customer_id,is_credit_enabled,credit_limit,terms_days,status,created_at,updated_at").in("customer_id", ids)),
  select("receivables", supabase.from("accounts_receivable").select("id,customer_id,order_id,invoice_id,historical_invoice_number,original_amount,balance_due,due_date,status,paid_at,created_at,updated_at").or(`customer_id.in.(${ids.join(",")}),id.eq.135d982c-a2a2-4991-9baf-baebd03fb63f`)),
  select("receivable_payments", supabase.from("accounts_receivable_payments").select("id,receivable_id,customer_id,order_id,amount,payment_method,reference,received_at,voided_at,created_at").or(`customer_id.in.(${ids.join(",")}),id.eq.f4a426b8-d96c-401a-8b42-66eae8342c08`)),
  select("crm_notes", supabase.from("crm_notes").select("id,customer_id,note_type,created_at,archived_at").in("customer_id", ids)),
  select("crm_followups", supabase.from("crm_followups").select("id,customer_id,title,status,due_at,created_at").in("customer_id", ids)),
  select("checkout_flags", supabase.from("checkout_feature_flags").select("key,enabled,version,reason,enabled_at,updated_at").eq("key", "checkout_order_v4")),
  select("accounting_flags", supabase.from("accounting_feature_flags").select("key,state,version,cutover_at,updated_at").eq("key", "supplier_multi_invoice_payment_v1")),
  select("active_checkout_requests", supabase.from("checkout_requests_v4").select("id,customer_id,user_id,status,order_id,created_at,updated_at").in("customer_id", ids).in("status", ["started", "processing"])),
  select("active_pos_drafts", supabase.from("pos_sale_drafts").select("id,customer_id,status,version,created_at,updated_at").in("customer_id", ids).eq("status", "active")),
]);

console.log(JSON.stringify({ auditedAt: new Date().toISOString(), results }, null, 2));
