import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  SupplierPaymentAccountingRepairPreview,
  SupplierPaymentRepairResult,
} from "@/types/supplier-payment-accounting-repair";

type PreviewRow = {
  preview?: SupplierPaymentAccountingRepairPreview | null;
};

function asPreviewRows(value: unknown): SupplierPaymentAccountingRepairPreview[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const preview = (row as PreviewRow).preview;
    return preview && typeof preview === "object" ? [preview] : [];
  });
}

export async function getSupplierPaymentAccountingRepairPreviews(
  paymentId?: string | null,
): Promise<SupplierPaymentAccountingRepairPreview[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "preview_supplier_payment_accounting_repairs_v1",
    { p_payment_id: paymentId ?? null },
  );

  if (error) {
    if (
      error.code === "PGRST202" ||
      error.message.includes("preview_supplier_payment_accounting_repairs_v1")
    ) {
      return [];
    }
    throw new Error(error.message);
  }

  return asPreviewRows(data);
}

export async function repairLateRecordedSupplierPayment(input: {
  requestKey: string;
  paymentId: string;
  expectedFingerprint: string;
  reason: string;
}): Promise<SupplierPaymentRepairResult> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "repair_late_recorded_supplier_payment_draft_v1",
    {
      p_request_key: input.requestKey,
      p_payment_id: input.paymentId,
      p_expected_fingerprint: input.expectedFingerprint,
      p_reason: input.reason,
    },
  );

  if (error) {
    throw new Error(error.message);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("La reparación no devolvió un resultado válido.");
  }

  return data as SupplierPaymentRepairResult;
}
