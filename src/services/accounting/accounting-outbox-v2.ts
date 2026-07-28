import "server-only";

import { randomUUID } from "node:crypto";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

export type AccountingOutboxV2Status =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "pending_mapping"
  | "pending_data"
  | "cancelled"
  | "shadow_validated";

export type AccountingOutboxV2Result = {
  ok: boolean;
  claimed: boolean;
  outboxId: string;
  outboxStatus: AccountingOutboxV2Status;
  eventId: string | null;
  journalEntryId: string | null;
  draftStatus: "borrador" | null;
  reason: string | null;
};

type RpcResult = {
  ok?: boolean;
  claimed?: boolean;
  outbox_id?: string;
  outbox_status?: AccountingOutboxV2Status;
  event_id?: string | null;
  journal_entry_id?: string | null;
  draft_status?: "borrador" | null;
  reason?: string | null;
};

function asRpcResult(value: unknown): RpcResult {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RpcResult)
    : {};
}

export async function processAccountingOutboxV2(input: {
  outboxId: string;
  forceRetry?: boolean;
}): Promise<AccountingOutboxV2Result> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("process_accounting_outbox_v2", {
    target_outbox_id: input.outboxId,
    worker_token: `server:${randomUUID()}`,
    force_retry: input.forceRetry ?? false,
  });

  if (error) {
    return {
      ok: false,
      claimed: false,
      outboxId: input.outboxId,
      outboxStatus: "failed",
      eventId: null,
      journalEntryId: null,
      draftStatus: null,
      reason: "technical_error",
    };
  }

  const result = asRpcResult(data);
  return {
    ok: result.ok === true,
    claimed: result.claimed === true,
    outboxId: result.outbox_id ?? input.outboxId,
    outboxStatus: result.outbox_status ?? "failed",
    eventId: result.event_id ?? null,
    journalEntryId: result.journal_entry_id ?? null,
    draftStatus: result.draft_status ?? (result.journal_entry_id ? "borrador" : null),
    reason: typeof result.reason === "string" ? result.reason : null,
  };
}

async function findOrderOutboxIds(orderId: string) {
  const admin = getSupabaseAdminClient();
  const [{ data: saleRows, error: saleError }, { data: movementRows, error: movementError }] =
    await Promise.all([
      admin
        .from("accounting_outbox_v2")
        .select("id")
        .eq("source_type", "order")
        .eq("source_id", orderId)
        .eq("posting_version", "v2"),
      admin
        .from("inventory_movements")
        .select("id")
        .eq("reference_type", "orders")
        .eq("reference_id", orderId)
        .eq("movement_type", "sale")
        .lt("quantity", 0),
    ]);

  if (saleError || movementError) {
    return [];
  }

  const movementIds = (movementRows ?? []).map((row) => row.id);
  let cogsRows: Array<{ id: string }> = [];
  if (movementIds.length > 0) {
    const { data, error } = await admin
      .from("accounting_outbox_v2")
      .select("id")
      .eq("source_type", "inventory_movement")
      .eq("posting_version", "v2")
      .in("source_id", movementIds);
    if (!error) cogsRows = data ?? [];
  }

  return [...new Set([...(saleRows ?? []), ...cogsRows].map((row) => row.id))];
}

export async function processAccountingOutboxesForOrderV2(orderId: string) {
  const outboxIds = await findOrderOutboxIds(orderId);
  return Promise.all(outboxIds.map((outboxId) => processAccountingOutboxV2({ outboxId })));
}

export async function processDueAccountingOutboxesV2(batchSize = 20) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("claim_due_accounting_outbox_v2", {
    batch_size: Math.min(Math.max(Math.trunc(batchSize), 1), 100),
  });
  if (error) throw new Error(error.message);

  const ids = (Array.isArray(data) ? data : [])
    .map((row) => (row && typeof row === "object" ? String((row as { outbox_id?: unknown }).outbox_id ?? "") : ""))
    .filter(Boolean);
  return Promise.all(ids.map((outboxId) => processAccountingOutboxV2({ outboxId })));
}
