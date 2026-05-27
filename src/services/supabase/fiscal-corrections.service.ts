import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  FiscalCorrectionHistoryEntry,
  FiscalCorrectionValueKey,
  FiscalCorrectionValues,
} from "@/types/fiscal-corrections";

type FiscalCorrectionHistoryRpcRow = Omit<
  FiscalCorrectionHistoryEntry,
  "fields_modified" | "old_values" | "new_values"
> & {
  fields_modified: string[] | null;
  old_values: unknown;
  new_values: unknown;
};

const allowedFiscalFields = new Set<FiscalCorrectionValueKey>([
  "customer_name",
  "customer_rtn",
  "customer_phone",
  "customer_email",
  "customer_address",
]);

function normalizeValues(value: unknown): FiscalCorrectionValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => allowedFiscalFields.has(key as FiscalCorrectionValueKey))
      .map(([key, entry]) => [key, entry == null ? null : String(entry)]),
  ) as FiscalCorrectionValues;
}

function normalizeHistoryRow(row: FiscalCorrectionHistoryRpcRow): FiscalCorrectionHistoryEntry {
  return {
    ...row,
    fields_modified: (row.fields_modified ?? []).filter((field): field is FiscalCorrectionValueKey =>
      allowedFiscalFields.has(field as FiscalCorrectionValueKey),
    ),
    old_values: normalizeValues(row.old_values),
    new_values: normalizeValues(row.new_values),
  };
}

export async function getFiscalCorrectionHistory({
  orderId = null,
  invoiceId = null,
}: {
  orderId?: string | null;
  invoiceId?: string | null;
}): Promise<FiscalCorrectionHistoryEntry[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .rpc("get_fiscal_correction_history", {
      target_order_id: orderId,
      target_invoice_id: invoiceId,
    })
    .returns<FiscalCorrectionHistoryRpcRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const rows = Array.isArray(data) ? data : [];
  return rows.map(normalizeHistoryRow);
}
