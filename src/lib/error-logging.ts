import { getSupabaseServerClient } from "@/lib/supabase-server";

type ErrorLogInput = {
  route?: string | null;
  action: string;
  errorMessage: string;
  errorStack?: string | null;
  metadata?: Record<string, unknown> | null;
};

function cleanString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function writeErrorLog(input: ErrorLogInput) {
  const supabase = await getSupabaseServerClient();
  const metadata = {
    environment: process.env.NODE_ENV,
    ...input.metadata,
  };

  const { error } = await supabase.rpc("write_error_log", {
    affected_route: cleanString(input.route),
    action_name: input.action,
    error_message: input.errorMessage,
    error_stack: cleanString(input.errorStack),
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
