import { getSupabaseServerClient } from "@/lib/supabase-server";

type AuditInput = {
  tableName: string;
  recordId?: string | null;
  action: string;
  oldData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
};

export async function writeAuditLog(input: AuditInput) {
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("write_audit_log", {
    target_table: input.tableName,
    target_record_id: input.recordId ?? null,
    action_name: input.action,
    previous_data: input.oldData ?? null,
    next_data: input.newData ?? null,
  });

  if (error) {
    console.error("Audit log failed", error.message);
  }
}

export function safeErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
