import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { generateJournalDraftFromFinancialEvent } from "@/services/accounting/journal-draft-generator";
import type { FinancialEventStatus } from "@/types/financial-center";

export type ReceivablePaymentAccountingReason =
  | "mapping_missing"
  | "period_closed"
  | "payment_voided"
  | "already_processing"
  | "retry_not_available"
  | "technical_error"
  | null;

export type ReceivablePaymentAccountingResult = {
  ok: boolean;
  outboxId: string;
  outboxStatus: "queued" | "processing" | "completed" | "failed";
  attempts: number;
  eventId: string | null;
  eventStatus: FinancialEventStatus | null;
  draftId: string | null;
  draftStatus: "borrador" | null;
  reason: ReceivablePaymentAccountingReason;
  validationErrors: string[];
};

type OutboxProcessRpcResult = {
  ok?: boolean;
  claimed?: boolean;
  outbox_id?: string;
  outbox_status?: "queued" | "processing" | "completed" | "failed";
  attempts?: number;
  event_id?: string | null;
  event_status?: FinancialEventStatus | null;
  journal_entry_id?: string | null;
  reason?: string | null;
  validation_errors?: unknown;
  error?: string;
};

const knownReasons = new Set<Exclude<ReceivablePaymentAccountingReason, null>>([
  "mapping_missing",
  "period_closed",
  "payment_voided",
  "already_processing",
  "retry_not_available",
  "technical_error",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeRpcResult(value: unknown): OutboxProcessRpcResult {
  return asRecord(value) as OutboxProcessRpcResult;
}

function normalizeErrors(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 10)
    : [];
}

function normalizeReason(value: unknown): ReceivablePaymentAccountingReason {
  return typeof value === "string" && knownReasons.has(value as Exclude<ReceivablePaymentAccountingReason, null>)
    ? (value as Exclude<ReceivablePaymentAccountingReason, null>)
    : null;
}

function reasonFromDraft(validationErrors: string[], message: string): ReceivablePaymentAccountingReason {
  const detail = [...validationErrors, message].join(" ").toLowerCase();
  if (detail.includes("periodo") || detail.includes("período")) return "period_closed";
  if (detail.includes("mapeo") || detail.includes("cuenta contable")) return "mapping_missing";
  if (detail.includes("anulad")) return "payment_voided";
  return "technical_error";
}

async function completeOutbox(
  client: SupabaseClient,
  input: {
    outboxId: string;
    workerToken: string;
    eventId: string;
    journalEntryId: string | null;
  },
) {
  const { error } = await client.rpc("complete_receivable_payment_accounting_outbox_v1", {
    target_outbox_id: input.outboxId,
    worker_token: input.workerToken,
    target_event_id: input.eventId,
    target_journal_entry_id: input.journalEntryId,
  });

  if (error) throw new Error(error.message);
}

async function failOutbox(
  client: SupabaseClient,
  input: {
    outboxId: string;
    workerToken: string;
    message: string;
  },
) {
  await client.rpc("fail_receivable_payment_accounting_outbox_v1", {
    target_outbox_id: input.outboxId,
    worker_token: input.workerToken,
    error_message: input.message.slice(0, 500),
  });
}

export async function processReceivablePaymentAccountingOutbox(input: {
  outboxId: string;
  actorId: string;
  forceRetry?: boolean;
}): Promise<ReceivablePaymentAccountingResult> {
  const client = await getSupabaseServerClient();
  const workerToken = `web:${randomUUID()}`;
  const { data, error } = await client.rpc("process_receivable_payment_accounting_outbox_v1", {
    target_outbox_id: input.outboxId,
    worker_token: workerToken,
    force_retry: input.forceRetry ?? false,
  });

  if (error) {
    return {
      ok: false,
      outboxId: input.outboxId,
      outboxStatus: "failed",
      attempts: 0,
      eventId: null,
      eventStatus: null,
      draftId: null,
      draftStatus: null,
      reason: "technical_error",
      validationErrors: [],
    };
  }

  const claimed = normalizeRpcResult(data);
  const outboxId = claimed.outbox_id ?? input.outboxId;
  const outboxStatus = claimed.outbox_status ?? "failed";
  const eventId = claimed.event_id ?? null;
  const eventStatus = claimed.event_status ?? null;
  const draftId = claimed.journal_entry_id ?? null;
  const validationErrors = normalizeErrors(claimed.validation_errors);
  const reason = normalizeReason(claimed.reason);

  if (claimed.ok === false) {
    return {
      ok: false,
      outboxId,
      outboxStatus: "failed",
      attempts: claimed.attempts ?? 0,
      eventId,
      eventStatus,
      draftId,
      draftStatus: draftId ? "borrador" : null,
      reason: "technical_error",
      validationErrors,
    };
  }

  if (!claimed.claimed) {
    const completed = outboxStatus === "completed";
    return {
      ok: completed,
      outboxId,
      outboxStatus,
      attempts: claimed.attempts ?? 0,
      eventId,
      eventStatus,
      draftId,
      draftStatus: draftId && eventStatus === "draft_created" ? "borrador" : null,
      reason,
      validationErrors,
    };
  }

  if (!eventId || !eventStatus) {
    await failOutbox(client, {
      outboxId,
      workerToken,
      message: "El procesador no devolvio un evento financiero recuperable.",
    });
    return {
      ok: false,
      outboxId,
      outboxStatus: "failed",
      attempts: claimed.attempts ?? 0,
      eventId,
      eventStatus,
      draftId: null,
      draftStatus: null,
      reason: "technical_error",
      validationErrors,
    };
  }

  if (eventStatus !== "ready") {
    await completeOutbox(client, {
      outboxId,
      workerToken,
      eventId,
      journalEntryId: draftId,
    });
    return {
      ok: true,
      outboxId,
      outboxStatus: "completed",
      attempts: claimed.attempts ?? 0,
      eventId,
      eventStatus,
      draftId,
      draftStatus: draftId && eventStatus === "draft_created" ? "borrador" : null,
      reason,
      validationErrors,
    };
  }

  try {
    const draft = await generateJournalDraftFromFinancialEvent(eventId, input.actorId, client);
    const recoveredDraft = Boolean(draft.journalEntryId);

    if (draft.ok || recoveredDraft) {
      await completeOutbox(client, {
        outboxId,
        workerToken,
        eventId,
        journalEntryId: draft.journalEntryId ?? null,
      });
      return {
        ok: true,
        outboxId,
        outboxStatus: "completed",
        attempts: claimed.attempts ?? 0,
        eventId,
        eventStatus: "draft_created",
        draftId: draft.journalEntryId ?? null,
        draftStatus: "borrador",
        reason: null,
        validationErrors: [],
      };
    }

    const draftErrors = draft.validationErrors ?? [];
    const draftReason = reasonFromDraft(draftErrors, draft.message);
    if (draftReason === "mapping_missing" || draftReason === "period_closed" || draftReason === "payment_voided") {
      await completeOutbox(client, {
        outboxId,
        workerToken,
        eventId,
        journalEntryId: null,
      });
      return {
        ok: true,
        outboxId,
        outboxStatus: "completed",
        attempts: claimed.attempts ?? 0,
        eventId,
        eventStatus: draft.status ?? "pending",
        draftId: null,
        draftStatus: null,
        reason: draftReason,
        validationErrors: draftErrors,
      };
    }

    await failOutbox(client, {
      outboxId,
      workerToken,
      message: draft.message,
    });
    return {
      ok: false,
      outboxId,
      outboxStatus: "failed",
      attempts: claimed.attempts ?? 0,
      eventId,
      eventStatus: draft.status ?? "failed",
      draftId: null,
      draftStatus: null,
      reason: "technical_error",
      validationErrors: draftErrors,
    };
  } catch {
    await failOutbox(client, {
      outboxId,
      workerToken,
      message: "Fallo tecnico durante la generacion del borrador.",
    });
    return {
      ok: false,
      outboxId,
      outboxStatus: "failed",
      attempts: claimed.attempts ?? 0,
      eventId,
      eventStatus: "failed",
      draftId: null,
      draftStatus: null,
      reason: "technical_error",
      validationErrors: [],
    };
  }
}

export async function findLatestReceivablePaymentOutboxId(receivableId: string) {
  const client = await getSupabaseServerClient();
  const { data: payment, error: paymentError } = await client
    .from("accounts_receivable_payments")
    .select("id")
    .eq("receivable_id", receivableId)
    .is("voided_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (paymentError) throw new Error(paymentError.message);
  if (!payment) return null;

  const { data: outbox, error: outboxError } = await client
    .from("accounting_outbox")
    .select("id")
    .eq("source_type", "receivable_payment")
    .eq("source_id", payment.id)
    .eq("event_purpose", "receivable_payment")
    .eq("posting_version", "v1")
    .maybeSingle<{ id: string }>();

  if (outboxError) throw new Error(outboxError.message);
  return outbox?.id ?? null;
}
