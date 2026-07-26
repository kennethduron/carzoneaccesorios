import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  assertPostRepair,
  collectScopedReceivablePaymentPreview,
  parseRepairArgs,
  scopedPublicReport,
  validateApplyPreflight,
} from "./scoped-receivable-payment-repair.mjs";

const requiredConfirmation = "APPLY_RECEIVABLE_PAYMENT_REPAIR";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable ${name}.`);
  return value;
}

function serviceClient() {
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function actorClient() {
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const actorToken = requiredEnv("SUPABASE_REPAIR_ACTOR_ACCESS_TOKEN");
  return createClient(url, requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${actorToken}` } },
  });
}

async function ensureOutbox(service, paymentId) {
  const { data: existing, error: existingError } = await service
    .from("accounting_outbox")
    .select("id")
    .eq("source_type", "receivable_payment")
    .eq("source_id", paymentId)
    .eq("event_purpose", "receivable_payment")
    .eq("posting_version", "v1")
    .limit(2);
  if (existingError) throw new Error(existingError.message);
  if ((existing ?? []).length > 1) throw new Error("Existen multiples outboxes exactas.");
  if (existing?.[0]) return existing[0].id;

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

async function repairOne(service, actor, payment, expectedEventId) {
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
    throw new Error(`La outbox no fue reclamada: ${processResult.reason ?? "estado desconocido"}.`);
  }

  const eventId = processResult.event_id;
  if (!eventId) throw new Error("La outbox no devolvio un evento.");
  if (eventId !== expectedEventId) {
    await fail(actor, {
      outboxId,
      worker,
      message: "El procesador devolvio un evento distinto del autorizado.",
    });
    throw new Error("El procesador devolvio un evento distinto del autorizado.");
  }
  if (processResult.event_status !== "ready") {
    await fail(actor, {
      outboxId,
      worker,
      message: `El evento no quedo listo: ${processResult.reason ?? processResult.event_status}.`,
    });
    throw new Error(`El evento no quedo listo: ${processResult.reason ?? processResult.event_status}.`);
  }

  const { data: draft, error: draftError } = await actor.rpc(
    "create_journal_draft_from_financial_event",
    {
      financial_event_id: eventId,
      entry_date_value: "2000-01-01",
      description_value: "Reparacion historica controlada",
      lines_data: [],
      actor_ip: null,
      actor_user_agent: "receivable-payment-repair-v2-scoped",
    },
  );
  if (draftError) {
    await fail(actor, { outboxId, worker, message: draftError.message });
    throw new Error(draftError.message);
  }
  if (!draft?.journal_entry_id) {
    await fail(actor, { outboxId, worker, message: "La RPC no devolvio la partida creada." });
    throw new Error("La RPC no devolvio la partida creada.");
  }

  await complete(actor, {
    outboxId,
    worker,
    eventId,
    journalEntryId: draft.journal_entry_id,
  });
  return { result: "draft_created", journalEntryId: draft.journal_entry_id };
}

async function main() {
  const options = parseRepairArgs(process.argv.slice(2));
  const service = serviceClient();
  const preview = await collectScopedReceivablePaymentPreview(service, options.paymentId);
  console.log(JSON.stringify(scopedPublicReport(preview), null, 2));

  if (!options.apply) {
    if (preview.payments.length === 0) console.log("Abono no encontrado. Cero modificaciones.");
    else if (preview.payments.length !== 1) {
      console.log("Resultado ambiguo. Reparacion bloqueada. Cero modificaciones.");
    } else console.log("Modo preview dirigido: no se modifico ningun dato.");
    return;
  }

  if (process.env.RECEIVABLE_PAYMENT_REPAIR_CONFIRM !== requiredConfirmation) {
    throw new Error(
      `Para aplicar se requiere RECEIVABLE_PAYMENT_REPAIR_CONFIRM=${requiredConfirmation}.`,
    );
  }

  const actor = actorClient();
  validateApplyPreflight(preview, options);
  const { data: actorUser, error: actorError } = await actor.auth.getUser();
  if (actorError || !actorUser.user) {
    throw new Error("El token del actor de reparacion no es valido.");
  }

  const immediatePreflight = await collectScopedReceivablePaymentPreview(service, options.paymentId);
  const authorized = validateApplyPreflight(immediatePreflight, options);
  console.log(JSON.stringify({
    mode: "APPLY_PREFLIGHT",
    selected_records: 1,
    payment_id: `${options.paymentId.slice(0, 8)}...`,
    event_id: `${authorized.event.id.slice(0, 8)}...`,
    action: "reconcile_outbox_and_create_draft",
    publication: false,
  }, null, 2));

  const result = await repairOne(service, actor, authorized.payment, authorized.event.id);
  const after = await collectScopedReceivablePaymentPreview(service, options.paymentId);
  const postRepair = assertPostRepair(immediatePreflight, after);
  console.log(JSON.stringify({
    mode: "APPLY",
    selected_records: 1,
    result: result.result,
    existing_event_reused: postRepair.existing_event_reused,
    outbox_completed: postRepair.outbox_completed,
    journal_entry_id: `${postRepair.journal_entry_id.slice(0, 8)}...`,
    journal_status: postRepair.journal_status,
    published_entries: 0,
    payment_rows_changed: 0,
    financial_events_inserted: 0,
    other_payments_changed: 0,
  }, null, 2));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
