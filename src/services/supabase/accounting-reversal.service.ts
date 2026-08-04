import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AccountingReversalValidatedInput } from "@/lib/validation/accounting-reversal";
import type { JournalReversalResult } from "@/types/accounting";

export type AccountingReversalRpcError = { code?: string; message: string };

export async function reverseJournalEntryWithEffectiveDate(
  input: AccountingReversalValidatedInput & { actorIp: string | null; actorUserAgent: string | null },
): Promise<{ data: JournalReversalResult | null; error: AccountingReversalRpcError | null }> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("reverse_journal_entry_v2", {
    target_entry_id: input.entryId,
    p_reversal_reason: input.reason,
    p_effective_date: input.effectiveDate,
    p_request_key: input.requestKey,
    p_expected_version: input.expectedVersion,
    actor_ip: input.actorIp,
    actor_user_agent: input.actorUserAgent,
  });
  return { data: error ? null : data as JournalReversalResult, error: error ? { code: error.code, message: error.message } : null };
}

export function accountingReversalErrorMessage(error: AccountingReversalRpcError | null) {
  if (!error) return "No se pudo reversar la partida. No se aplicó ningún cambio.";
  const message = error.message ?? "";
  if (error.code === "40001" || message.includes("REVERSAL_VERSION_CONFLICT")) return "La partida fue modificada por otro usuario. Recargue la información antes de continuar.";
  if (message.includes("REVERSAL_EFFECTIVE_DATE_REQUIRED")) return "Seleccione la fecha efectiva de la reversión.";
  if (message.includes("REVERSAL_EFFECTIVE_DATE_IN_FUTURE")) return "La fecha efectiva de la reversión no puede ser futura.";
  if (message.includes("REVERSAL_ACCOUNTING_PERIOD_CLOSED")) return "No se puede registrar la reversión en esa fecha porque el período contable está cerrado.";
  if (message.includes("REVERSAL_REASON_INVALID")) return "El motivo de la reversión debe tener entre 10 y 500 caracteres.";
  if (message.includes("REVERSAL_ALREADY_EXISTS")) return "La partida ya fue reversada. Recargue la información antes de continuar.";
  if (message.includes("REVERSAL_ENTRY_NOT_PUBLISHED")) return "Solo se pueden reversar partidas publicadas.";
  if (message.includes("REVERSAL_OF_REVERSAL_NOT_ALLOWED")) return "Una partida de reversión no puede volver a reversarse.";
  if (message.includes("REVERSAL_ENTRY_NOT_FOUND")) return "La partida ya no está disponible. Recargue la información.";
  if (message.includes("REVERSAL_IDEMPOTENCY_KEY_REUSED")) return "La solicitud de reversión ya fue utilizada con datos diferentes. Vuelva a abrir el diálogo.";
  if (error.code === "42501" || message.includes("REVERSAL_PERMISSION_DENIED")) return "No tiene permiso para reversar partidas.";
  return "No se pudo reversar la partida. No se aplicó ningún cambio.";
}
