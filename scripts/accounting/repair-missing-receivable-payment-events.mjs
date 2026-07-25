import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  collectReceivablePaymentAccountingPreview,
  publicPreviewReport,
} from "./preview-missing-receivable-payment-events.mjs";

const applyRequested = process.argv.includes("--apply");
const requiredConfirmation = "APPLY_RECEIVABLE_PAYMENT_REPAIR";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable ${name}.`);
  return value;
}

function clients() {
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const service = createClient(url, requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const actorToken = requiredEnv("SUPABASE_REPAIR_ACTOR_ACCESS_TOKEN");
  const actor = createClient(url, requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${actorToken}` } },
  });
  return { service, actor };
}

async function ensureOutbox(service, paymentId) {
  const { data: existing, error: existingError } = await service
    .from("accounting_outbox")
    .select("id")
    .eq("source_type", "receivable_payment")
    .eq("source_id", paymentId)
    .eq("event_purpose", "receivable_payment")
    .eq("posting_version", "v1")
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing) return existing.id;

  const { data, error } = await service
    .from("accounting_outbox")
    .insert({
      source_type: "receivable_payment",
      source_id: paymentId,
      event_purpose: "receivable_payment",
      posting_version: "v1",
      status: "queued",
    })
    .select("id")
    .single();
  if (error?.code === "23505") return ensureOutbox(service, paymentId);
  if (error) throw new Error(error.message);
  return data.id;
}

async function complete(actor, input) {
  const { error } = await actor.rpc("complete_receivable_payment_accounting_outbox_v1", {
    target_outbox_id: input.outboxId,
    worker_token: input.worker,
    target_event_id: input.eventId,
    target_journal_entry_id: input.journalEntryId,
  });
  if (error) throw new Error(error.message);
}

async function fail(actor, input) {
  await actor.rpc("fail_receivable_payment_accounting_outbox_v1", {
    target_outbox_id: input.outboxId,
    worker_token: input.worker,
    error_message: input.message.slice(0, 500),
  });
}

async function repairOne(service, actor, payment) {
  const outboxId = await ensureOutbox(service, payment.id);
  const worker = `repair:${randomUUID()}`;
  const { data: processResult, error: processError } = await actor.rpc(
    "process_receivable_payment_accounting_outbox_v1",
    {
      target_outbox_id: outboxId,
      worker_token: worker,
      force_retry: true,
    },
  );
  if (processError) throw new Error(processError.message);
  if (!processResult?.ok) throw new Error(processResult?.error || "No se pudo procesar la outbox.");
  if (!processResult.claimed) {
    return {
      result: "reused",
      eventStatus: processResult.event_status ?? null,
      draftCreated: Boolean(processResult.journal_entry_id),
    };
  }

  const eventId = processResult.event_id;
  if (!eventId) throw new Error("La outbox no devolvió un evento.");
  if (processResult.event_status !== "ready") {
    await complete(actor, { outboxId, worker, eventId, journalEntryId: null });
    return {
      result: "pending",
      eventStatus: processResult.event_status,
      draftCreated: false,
      reason: processResult.reason ?? null,
    };
  }

  const { data: draft, error: draftError } = await actor.rpc(
    "create_journal_draft_from_financial_event",
    {
      financial_event_id: eventId,
      entry_date_value: "2000-01-01",
      description_value: "Reparación histórica controlada",
      lines_data: [],
      actor_ip: null,
      actor_user_agent: "receivable-payment-repair-v1",
    },
  );
  if (draftError) {
    await fail(actor, { outboxId, worker, message: draftError.message });
    throw new Error(draftError.message);
  }

  await complete(actor, {
    outboxId,
    worker,
    eventId,
    journalEntryId: draft?.journal_entry_id ?? null,
  });
  return {
    result: "draft_created",
    eventStatus: "draft_created",
    draftCreated: true,
  };
}

async function main() {
  const preview = await collectReceivablePaymentAccountingPreview();
  console.log(JSON.stringify(publicPreviewReport(preview), null, 2));

  if (!applyRequested) {
    console.log("Modo preview: no se modificó ningún dato. Usa --apply solo después de aprobar este resultado.");
    return;
  }

  if (process.env.RECEIVABLE_PAYMENT_REPAIR_CONFIRM !== requiredConfirmation) {
    throw new Error(
      `Para aplicar se requiere RECEIVABLE_PAYMENT_REPAIR_CONFIRM=${requiredConfirmation}.`,
    );
  }

  const candidates = preview.recoverablePayments.filter(
    (payment) => !preview.possibleManualByPayment.has(payment.id),
  );
  const excludedManual = preview.recoverablePayments.length - candidates.length;
  const { service, actor } = clients();
  const { data: actorUser, error: actorError } = await actor.auth.getUser();
  if (actorError || !actorUser.user) {
    throw new Error("El token del actor de reparación no es válido.");
  }

  const summary = {
    candidates: candidates.length,
    excluded_possible_manual: excludedManual,
    draft_created: 0,
    pending: 0,
    reused: 0,
    failed: 0,
  };

  for (const payment of candidates) {
    try {
      const result = await repairOne(service, actor, payment);
      if (result.result === "draft_created") summary.draft_created += 1;
      else if (result.result === "pending") summary.pending += 1;
      else summary.reused += 1;
    } catch {
      summary.failed += 1;
    }
  }

  console.log(JSON.stringify({
    mode: "APPLY",
    ...summary,
    published_entries: 0,
  }, null, 2));

  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
