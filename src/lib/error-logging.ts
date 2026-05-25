import { getSupabaseServerClient } from "@/lib/supabase-server";
import {
  hashEmail,
  maskEmail,
  sanitizeLogText,
  sanitizeMetadata,
  type OperationalCategory,
  type OperationalSeverity,
} from "@/lib/operational-errors";

type ErrorLogInput = {
  route?: string | null;
  module?: string | null;
  category?: OperationalCategory;
  severity?: OperationalSeverity;
  status?: "open" | "reviewing" | "resolved" | "ignored";
  action: string;
  errorMessage: string;
  errorStack?: string | null;
  errorCode?: string | null;
  httpStatus?: number | null;
  customerMessage?: string | null;
  adminReason?: string | null;
  recommendation?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  metadata?: Record<string, unknown> | null;
};

function cleanString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function inferCategory(action: string, route?: string | null): OperationalCategory {
  const value = `${action} ${route ?? ""}`.toLowerCase();
  if (value.includes("auth") || value.includes("login") || value.includes("registro") || value.includes("password")) return "auth";
  if (value.includes("checkout") || value.includes("order")) return "checkout";
  if (value.includes("payment") || value.includes("pago") || value.includes("bac")) return "payments";
  if (value.includes("invoice") || value.includes("factura") || value.includes("fiscal")) return "invoices";
  if (value.includes("inventory") || value.includes("inventario") || value.includes("stock")) return "inventory";
  if (value.includes("wholesale") || value.includes("mayoreo")) return "wholesale";
  if (value.includes("email") || value.includes("notification")) return "email";
  if (value.includes("cron")) return "cron";
  if (value.includes("crm") || value.includes("customer")) return "crm";
  return "system";
}

export async function writeErrorLog(input: ErrorLogInput) {
  const supabase = await getSupabaseServerClient();
  const emailMasked = maskEmail(input.userEmail);
  const emailHash = hashEmail(input.userEmail);
  const category = input.category ?? inferCategory(input.action, input.route);
  const moduleName = input.module ?? category;
  const metadata = {
    environment: process.env.NODE_ENV,
    module: moduleName,
    category,
    severity: input.severity ?? "error",
    status: input.status ?? "open",
    code: input.errorCode,
    http_status: input.httpStatus,
    customer_message: input.customerMessage,
    admin_reason: input.adminReason,
    recommendation: input.recommendation,
    related_user_id: input.userId,
    email_masked: emailMasked,
    email_hash: emailHash,
    ...sanitizeMetadata(input.metadata),
  };

  const { error } = await supabase.rpc("write_error_log", {
    affected_route: cleanString(input.route),
    action_name: input.action,
    error_message: sanitizeLogText(input.errorMessage, 700) || "Unknown error",
    error_stack: cleanString(sanitizeLogText(input.errorStack, 2000)),
    error_metadata: metadata,
  });

  if (error) {
    console.error("Error log failed", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
  }
}
