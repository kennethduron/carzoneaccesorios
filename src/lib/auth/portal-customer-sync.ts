import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

export type PortalCustomerSyncSource =
  | "registration"
  | "callback"
  | "login"
  | "checkout_recovery";

export type PortalCustomerSyncResult = {
  ok: boolean;
  code:
    | "PROFILE_CREATED"
    | "ALREADY_LINKED"
    | "REVIEW_REQUIRED"
    | "INTERNAL_USER_IGNORED"
    | "INACTIVE_ACCOUNT"
    | "INVALID_ACCOUNT"
    | "AUTH_REQUIRED"
    | "INVALID_INPUT"
    | "INVALID_SOURCE"
    | "IDEMPOTENCY_CONFLICT"
    | string;
  message: string;
  state?: string;
  customerId?: string;
  reviewId?: string;
  candidateCount?: number;
  emailConfirmed?: boolean;
  idempotentReplay?: boolean;
};

function deterministicUuid(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const normalized = hex.join("");
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

export function portalCustomerSyncRequestKey(userId: string, source: PortalCustomerSyncSource, eventKey = "current") {
  return deterministicUuid(`carzone:portal-customer-profile:v1:${source}:${userId}:${eventKey}`);
}

function normalizeResult(data: unknown): PortalCustomerSyncResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Portal customer synchronization returned an invalid response.");
  }

  const result = data as Partial<PortalCustomerSyncResult>;
  if (typeof result.ok !== "boolean" || typeof result.code !== "string" || typeof result.message !== "string") {
    throw new Error("Portal customer synchronization returned an incomplete response.");
  }

  return result as PortalCustomerSyncResult;
}

function throwOnOperationalFailure(result: PortalCustomerSyncResult) {
  if (result.code === "SYNC_FAILED" || result.code === "IDEMPOTENCY_CONFLICT") {
    throw new Error(result.message);
  }
  return result;
}

export async function ensurePortalCustomerProfileForUser(
  userId: string,
  source: PortalCustomerSyncSource,
  eventKey?: string | null,
): Promise<PortalCustomerSyncResult> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("ensure_portal_customer_profile_internal_v1", {
    p_portal_user_id: userId,
    p_source: source,
    p_request_key: portalCustomerSyncRequestKey(userId, source, eventKey ?? "current"),
  });

  if (error) {
    throw new Error(error.message);
  }

  return throwOnOperationalFailure(normalizeResult(data));
}

export async function ensureMyPortalCustomerProfile(
  supabase: SupabaseClient,
  userId: string,
  source: Exclude<PortalCustomerSyncSource, "registration">,
  eventKey?: string | null,
): Promise<PortalCustomerSyncResult> {
  const { data, error } = await supabase.rpc("ensure_my_portal_customer_profile_v1", {
    p_source: source,
    p_request_key: portalCustomerSyncRequestKey(userId, source, eventKey ?? "current"),
  });

  if (error) {
    throw new Error(error.message);
  }

  return throwOnOperationalFailure(normalizeResult(data));
}
