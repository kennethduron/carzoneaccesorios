"use server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { WholesaleValidationResult } from "@/types/wholesale";

type WholesaleCodeRpcRow = {
  id: string;
  code: string;
  customer_id: string | null;
  customer_name: string | null;
  business_name: string | null;
  label: string;
  minimum_order: number | string;
  expires_at: string | null;
  used_count: number;
  status: "active" | "inactive" | "expired" | "disabled";
};

export async function validateWholesaleCodeAction(code: string): Promise<WholesaleValidationResult> {
  const normalizedCode = code.trim().toUpperCase();

  if (!normalizedCode) {
    return {
      ok: false,
      message: "Ingresa un código mayorista.",
      account: null,
    };
  }

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .rpc("validate_wholesale_code", { raw_code: normalizedCode })
      .returns<WholesaleCodeRpcRow[]>();

    if (error) {
      return {
        ok: false,
        message: "No se pudo validar el código mayorista.",
        account: null,
      };
    }

    const rows = Array.isArray(data) ? (data as WholesaleCodeRpcRow[]) : [];
    const account = rows[0];

    if (!account) {
      return {
        ok: false,
        message: "Código mayorista inválido, inactivo, vencido o sin usos disponibles.",
        account: null,
      };
    }

    return {
      ok: true,
      message: `Modo mayorista activo para ${account.business_name ?? account.label}. Usando precio mayorista.`,
      account: {
        id: account.id,
        code: account.code,
        customerId: account.customer_id,
        customerName: account.customer_name ?? account.label,
        businessName: account.business_name ?? account.label,
        minimumOrder: Number(account.minimum_order),
        expiresAt: account.expires_at,
        usedCount: account.used_count,
        status: account.status,
      },
    };
  } catch {
    return {
      ok: false,
      message: "Configura Supabase para validar códigos mayoristas reales.",
      account: null,
    };
  }
}
