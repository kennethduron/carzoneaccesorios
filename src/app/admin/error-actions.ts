"use server";

import { writeErrorLog } from "@/lib/error-logging";

type AdminErrorPayload = {
  route?: string | null;
  action?: string | null;
  message?: string | null;
  stack?: string | null;
  digest?: string | null;
  name?: string | null;
  supabaseError?: {
    code?: string | null;
    details?: string | null;
    hint?: string | null;
    status?: number | string | null;
  } | null;
};

export async function logAdminErrorAction(payload: AdminErrorPayload) {
  await writeErrorLog({
    route: payload.route ?? "/admin",
    action: payload.action?.trim() || "admin.error_boundary",
    errorMessage: payload.message?.trim() || "Unknown admin panel error",
    errorStack: payload.stack ?? null,
    metadata: {
      digest: payload.digest ?? null,
      name: payload.name ?? null,
      supabaseError: payload.supabaseError ?? null,
      source: "admin-error-boundary",
    },
  });
}
