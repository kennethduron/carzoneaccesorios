import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  SupplierMultiPaymentInput,
  SupplierMultiPaymentRpcResult,
  SupplierOpenPayablesQuery,
} from "@/schemas/supplier-multi-payment";

export type SupplierOpenPayable = {
  id: string;
  supplier_id: string;
  purchase_id: string | null;
  supplier_invoice_id: string | null;
  purchase_number: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_amount: number;
  paid_amount: number;
  balance: number;
  status: "pending" | "partial" | "overdue";
  currency: string;
};

export type SupplierMultiPaymentHistoryItem = {
  id: string;
  supplier_id: string;
  supplier_name: string;
  amount: number;
  payment_method: string;
  status: "paid" | "voided";
  paid_at: string | null;
  created_at: string;
  application_count: number;
  applications: Array<{
    id: string;
    accounts_payable_id: string;
    applied_amount: number;
    status: "applied" | "voided";
  }>;
};

type OpenPayableRow = Omit<
  SupplierOpenPayable,
  "purchase_number" | "invoice_number" | "invoice_date" | "total_amount" | "paid_amount" | "balance"
> & {
  total_amount: unknown;
  paid_amount: unknown;
  balance: unknown;
  supplier_invoices: {
    invoice_number: string;
    invoice_date: string;
  } | null;
  purchases: {
    purchase_number: string;
  } | null;
};

export type SupplierPaymentMethodAccount = {
  method: SupplierMultiPaymentInput["payment_method"];
  accountCode: string;
  accountName: string;
};

export type SupplierMultiPaymentConfig = {
  enabled: boolean;
  cutoverAt: string | null;
  methodAccounts: SupplierPaymentMethodAccount[];
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

export async function getSupplierOpenPayables(
  input: SupplierOpenPayablesQuery,
): Promise<{
  items: SupplierOpenPayable[];
  nextCursor: { dueDate: string | null; id: string } | null;
}> {
  const admin = getSupabaseAdminClient();
  let invoiceIds: string[] | null = null;

  if (input.query) {
    const { data: invoices, error: invoiceError } = await admin
      .from("supplier_invoices")
      .select("id")
      .eq("supplier_id", input.supplier_id)
      .ilike("invoice_number", `%${input.query.replace(/[%_]/g, "\\$&")}%`)
      .limit(200)
      .returns<Array<{ id: string }>>();

    if (invoiceError) {
      throw new Error("No se pudo buscar la factura del proveedor.");
    }

    invoiceIds = (invoices ?? []).map((invoice) => invoice.id);
    if (invoiceIds.length === 0) {
      return { items: [], nextCursor: null };
    }
  }

  let query = admin
    .from("accounts_payable")
    .select(
      `
        id,
        supplier_id,
        purchase_id,
        supplier_invoice_id,
        due_date,
        total_amount,
        paid_amount,
        balance,
        status,
        currency,
        supplier_invoices(invoice_number, invoice_date),
        purchases(purchase_number)
      `,
    )
    .eq("supplier_id", input.supplier_id)
    .in("status", ["pending", "partial", "overdue"])
    .gt("balance", 0)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true })
    .limit(input.page_size + 1);

  if (input.accounts_payable_id) {
    query = query.eq("id", input.accounts_payable_id);
  }

  if (invoiceIds) {
    query = query.in("supplier_invoice_id", invoiceIds);
  }

  if (input.cursor_due_date && input.cursor_id) {
    query = query.or(
      `due_date.gt.${input.cursor_due_date},and(due_date.eq.${input.cursor_due_date},id.gt.${input.cursor_id}),due_date.is.null`,
    );
  } else if (input.cursor_id) {
    query = query.is("due_date", null).gt("id", input.cursor_id);
  }

  const { data, error } = await query.returns<OpenPayableRow[]>();
  if (error) {
    throw new Error("No se pudieron cargar las cuentas por pagar.");
  }

  const rows = data ?? [];
  const hasMore = rows.length > input.page_size;
  const pageRows = rows.slice(0, input.page_size);
  const items = pageRows.map((row) => ({
    id: row.id,
    supplier_id: row.supplier_id,
    purchase_id: row.purchase_id,
    supplier_invoice_id: row.supplier_invoice_id,
    purchase_number: row.purchases?.purchase_number ?? null,
    invoice_number: row.supplier_invoices?.invoice_number ?? null,
    invoice_date: row.supplier_invoices?.invoice_date ?? null,
    due_date: row.due_date,
    total_amount: toNumber(row.total_amount),
    paid_amount: toNumber(row.paid_amount),
    balance: toNumber(row.balance),
    status: row.status,
    currency: row.currency,
  }));
  const last = items.at(-1);

  return {
    items,
    nextCursor:
      hasMore && last ? { dueDate: last.due_date, id: last.id } : null,
  };
}

export async function getSupplierMultiPaymentConfig(): Promise<SupplierMultiPaymentConfig> {
  const admin = getSupabaseAdminClient();
  const [flagResult, mappingResult] = await Promise.all([
    admin
      .from("accounting_feature_flags")
      .select("state, cutover_at")
      .eq("key", "supplier_multi_invoice_payment_v1")
      .maybeSingle<{ state: string; cutover_at: string | null }>(),
    admin
      .from("accounting_mappings")
      .select("source_key, priority, accounting_accounts(code, name, is_active)")
      .eq("mapping_type", "payment_method")
      .eq("is_active", true)
      .in("source_key", [
        "supplier_payment_cash",
        "supplier_payment_bank",
        "supplier_payment_card",
      ])
      .order("priority", { ascending: true })
      .returns<
        Array<{
          source_key: string;
          priority: number;
          accounting_accounts: {
            code: string;
            name: string;
            is_active: boolean;
          } | null;
        }>
      >(),
  ]);

  if (flagResult.error || mappingResult.error) {
    return { enabled: false, cutoverAt: null, methodAccounts: [] };
  }

  const firstByKey = new Map<
    string,
    { code: string; name: string; is_active: boolean }
  >();
  for (const mapping of mappingResult.data ?? []) {
    if (mapping.accounting_accounts?.is_active && !firstByKey.has(mapping.source_key)) {
      firstByKey.set(mapping.source_key, mapping.accounting_accounts);
    }
  }

  const definitions: Array<{
    method: SupplierMultiPaymentInput["payment_method"];
    sourceKey: string;
  }> = [
    { method: "cash", sourceKey: "supplier_payment_cash" },
    { method: "bank_transfer", sourceKey: "supplier_payment_bank" },
    { method: "card_credit", sourceKey: "supplier_payment_card" },
    { method: "card_debit", sourceKey: "supplier_payment_bank" },
  ];
  const methodAccounts = definitions.flatMap<SupplierPaymentMethodAccount>(
    ({ method, sourceKey }) => {
      const account = firstByKey.get(sourceKey);
      return account
        ? [{ method, accountCode: account.code, accountName: account.name }]
        : [];
    },
  );
  const cutoverAt = flagResult.data?.cutover_at ?? null;

  return {
    enabled:
      flagResult.data?.state === "enabled" &&
      Boolean(cutoverAt) &&
      new Date(cutoverAt ?? 0).getTime() <= Date.now() &&
      methodAccounts.length === definitions.length,
    cutoverAt,
    methodAccounts,
  };
}

export async function registerSupplierMultiPayment(
  input: SupplierMultiPaymentInput,
): Promise<SupplierMultiPaymentRpcResult> {
  const supabase = await getSupabaseServerClient();
  const parameters = {
    p_request_key: input.request_key,
    p_supplier_id: input.supplier_id,
    p_payment_method: input.payment_method,
    p_paid_date: input.paid_date,
    p_reference: input.reference ?? null,
    p_applications: input.applications,
    p_notes: input.notes ?? null,
    p_receipt_public_id: input.receipt_public_id ?? null,
  };
  let response = await supabase.rpc(
    "register_supplier_multi_payment_v1",
    parameters,
  );

  if (
    response.error &&
    (!response.error.code || response.error.code.startsWith("PGRST0"))
  ) {
    response = await supabase.rpc(
      "register_supplier_multi_payment_v1",
      parameters,
    );
  }

  if (response.error) {
    throw response.error;
  }

  return response.data as SupplierMultiPaymentRpcResult;
}


export async function getSupplierMultiPaymentHistory(): Promise<
  SupplierMultiPaymentHistoryItem[]
> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("supplier_payments")
    .select(
      `
        id,
        supplier_id,
        amount,
        payment_method,
        status,
        paid_at,
        created_at,
        suppliers(name),
        supplier_payment_applications(
          id,
          accounts_payable_id,
          applied_amount,
          status
        )
      `,
    )
    .eq("allocation_mode", "applications_v1")
    .in("status", ["paid", "voided"])
    .order("created_at", { ascending: false })
    .limit(100)
    .returns<
      Array<{
        id: string;
        supplier_id: string;
        amount: unknown;
        payment_method: string;
        status: "paid" | "voided";
        paid_at: string | null;
        created_at: string;
        suppliers: { name: string } | null;
        supplier_payment_applications: Array<{
          id: string;
          accounts_payable_id: string;
          applied_amount: unknown;
          status: "applied" | "voided";
        }> | null;
      }>
    >();

  if (error) {
    throw new Error("No se pudo cargar el historial de pagos multifáctura.");
  }

  return (data ?? []).map((row) => ({
    ...row,
    supplier_name: row.suppliers?.name ?? "Proveedor",
    amount: toNumber(row.amount),
    application_count: row.supplier_payment_applications?.length ?? 0,
    applications: (row.supplier_payment_applications ?? []).map((application) => ({
      ...application,
      applied_amount: toNumber(application.applied_amount),
    })),
  }));
}
