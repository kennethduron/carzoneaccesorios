"use server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { WholesaleValidationResult } from "@/types/wholesale";

const wholesaleMessages = {
  invalidCode: "Código mayorista inválido.",
  loginRequired: "Código válido. Inicia sesión con tu cuenta mayorista para activar precios.",
  codeNotOwned: "Este código mayorista no pertenece a tu cuenta.",
  accountNotAuthorized: "Tu cuenta no está autorizada para compras mayoristas.",
  success: "Cuenta mayorista verificada. Precios de mayoreo activados.",
};

type WholesaleCodePublicRpcRow = {
  code: string;
  is_valid: boolean;
  status: string;
  message: string;
  requires_login: boolean;
  expires_at: string | null;
};

type CustomerAuthorizationRow = {
  id: string;
  is_wholesale: boolean;
  status: "active" | "inactive" | "disabled" | "pending_account";
  active: boolean;
};

type WholesaleAccountRpcRow = {
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

function toWholesaleAccount(account: WholesaleAccountRpcRow) {
  return {
    id: account.id,
    code: account.code,
    customerId: account.customer_id,
    customerName: account.customer_name ?? account.label,
    businessName: account.business_name ?? account.label,
    minimumOrder: Number(account.minimum_order),
    expiresAt: account.expires_at,
    usedCount: account.used_count,
    status: account.status,
  };
}

export async function validateWholesaleCodeAction(code: string): Promise<WholesaleValidationResult> {
  const normalizedCode = code.trim().toUpperCase();

  if (!normalizedCode) {
    return {
      ok: false,
      message: wholesaleMessages.invalidCode,
      account: null,
    };
  }

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .rpc("validate_wholesale_code_public", { raw_code: normalizedCode })
      .returns<WholesaleCodePublicRpcRow[]>();

    if (error) {
      return {
        ok: false,
        message: wholesaleMessages.invalidCode,
        account: null,
      };
    }

    const rows = Array.isArray(data) ? (data as WholesaleCodePublicRpcRow[]) : [];
    const publicValidation = rows[0];

    if (!publicValidation?.is_valid) {
      return {
        ok: false,
        message: publicValidation?.message ?? wholesaleMessages.invalidCode,
        account: null,
      };
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return {
        ok: true,
        message: wholesaleMessages.loginRequired,
        account: null,
        requiresLogin: publicValidation.requires_login,
        code: publicValidation.code,
      };
    }

    const { data: activatedData, error: activationError } = await supabase
      .rpc("activate_wholesale_account", { raw_code: normalizedCode })
      .returns<WholesaleAccountRpcRow[]>();

    if (activationError) {
      return {
        ok: false,
        message: wholesaleMessages.accountNotAuthorized,
        account: null,
      };
    }

    const activatedRows = Array.isArray(activatedData) ? (activatedData as WholesaleAccountRpcRow[]) : [];
    const activatedAccount = activatedRows[0];

    if (!activatedAccount) {
      const { data: customerRows } = await supabase
        .from("customers")
        .select("id, is_wholesale, status, active")
        .eq("user_id", user.id)
        .returns<CustomerAuthorizationRow[]>();

      const hasAuthorizedWholesaleAccount = (customerRows ?? []).some(
        (customer) => customer.is_wholesale && customer.active && customer.status === "active",
      );

      return {
        ok: false,
        message: hasAuthorizedWholesaleAccount ? wholesaleMessages.codeNotOwned : wholesaleMessages.accountNotAuthorized,
        account: null,
      };
    }

    return {
      ok: true,
      message: wholesaleMessages.success,
      account: toWholesaleAccount(activatedAccount),
    };
  } catch {
    return {
      ok: false,
      message: wholesaleMessages.invalidCode,
      account: null,
    };
  }
}
