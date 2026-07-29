import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import {
  createGuestPortalCommercialContext,
  type PortalCommercialBlockCode,
  type PortalCommercialContext,
  type PortalCommercialWarningCode,
} from "@/types/portal-commercial";

type CommercialContextRpcRow = Partial<Record<keyof PortalCommercialContext, unknown>>;

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArray<T extends string>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((item): item is T => typeof item === "string") : [];
}

export async function getPortalCommercialContext(): Promise<PortalCommercialContext> {
  const fallback = createGuestPortalCommercialContext();

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.rpc("resolve_portal_commercial_context_v1");

    if (error || !data || typeof data !== "object" || Array.isArray(data)) {
      return fallback;
    }

    const row = data as CommercialContextRpcRow;
    const commercialVersion = numberOrNull(row.commercialVersion);
    const serverTimestamp =
      typeof row.serverTimestamp === "string" && !Number.isNaN(Date.parse(row.serverTimestamp))
        ? row.serverTimestamp
        : new Date().toISOString();

    return {
      authenticated: row.authenticated === true,
      accountActive: row.accountActive === true,
      linked: row.linked === true,
      customerId: typeof row.customerId === "string" ? row.customerId : null,
      commercialVersion,
      customerActive: row.customerActive === true,
      effectivePriceMode: row.effectivePriceMode === "wholesale" ? "wholesale" : "retail",
      wholesaleStatus:
        row.wholesaleStatus === "pending" ||
        row.wholesaleStatus === "approved" ||
        row.wholesaleStatus === "rejected" ||
        row.wholesaleStatus === "suspended"
          ? row.wholesaleStatus
          : "none",
      wholesaleCustomerType:
        row.wholesaleCustomerType === "new" || row.wholesaleCustomerType === "existing"
          ? row.wholesaleCustomerType
          : null,
      firstPurchaseRequired: row.firstPurchaseRequired === true,
      firstPurchaseMinimum: numberOrNull(row.firstPurchaseMinimum) ?? 0,
      firstPurchaseCompleted: row.firstPurchaseCompleted === true,
      firstPurchaseAccumulated: numberOrNull(row.firstPurchaseAccumulated) ?? 0,
      creditAccountExists: row.creditAccountExists === true,
      creditEnabled: row.creditEnabled === true,
      creditStatus: row.creditStatus === "active" || row.creditStatus === "suspended" ? row.creditStatus : null,
      creditLimit: numberOrNull(row.creditLimit),
      creditUsed: numberOrNull(row.creditUsed),
      creditAvailable: numberOrNull(row.creditAvailable),
      creditTermsDays: numberOrNull(row.creditTermsDays),
      overdueBalance: numberOrNull(row.overdueBalance),
      creditUsable: row.creditUsable === true,
      blockCodes: stringArray<PortalCommercialBlockCode>(row.blockCodes),
      warningCodes: stringArray<PortalCommercialWarningCode>(row.warningCodes),
      pendingLinkEvidence: row.pendingLinkEvidence === true,
      contextToken: typeof row.contextToken === "string" ? row.contextToken : null,
      serverTimestamp,
    };
  } catch {
    return fallback;
  }
}
