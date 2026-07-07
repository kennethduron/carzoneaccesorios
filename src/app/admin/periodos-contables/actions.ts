"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AccountingPeriod, AccountingPeriodInput, AccountingPeriodType } from "@/types/accounting";

type AccountingPeriodActionResult = {
  ok: boolean;
  message: string;
};

const periodTypes = new Set<AccountingPeriodType>(["monthly", "annual", "custom"]);
const invalidDateMessage = "La fecha inicial debe ser anterior a la fecha final.";
const overlapMessage = "El período contable se cruza con otro período existente.";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanDate(value: unknown) {
  const text = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function cleanFiscalYear(value: unknown) {
  const year = Number(value);
  return Number.isInteger(year) ? year : 0;
}

async function logAccountingPeriodEvent(input: {
  eventType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}) {
  const supabase = await getSupabaseServerClient();
  await supabase.from("accounting_event_log").insert({
    event_type: input.eventType,
    entity_type: "accounting_periods",
    entity_id: input.entityId ?? null,
    source_type: null,
    source_id: null,
    metadata: input.metadata ?? {},
    created_by: input.createdBy ?? null,
  });
}

async function auditInvalidAttempt(message: string, input: AccountingPeriodInput, userId: string) {
  const payload = {
    reason: message,
    name: cleanText(input.name).slice(0, 120),
    start_date: cleanDate(input.start_date),
    end_date: cleanDate(input.end_date),
    fiscal_year: cleanFiscalYear(input.fiscal_year),
  };

  await writeAuditLog({
    tableName: "accounting_periods",
    action: "accounting.period.invalid_attempt",
    newData: payload,
  });
  await logAccountingPeriodEvent({
    eventType: "period.invalid_attempt",
    metadata: payload,
    createdBy: userId,
  });
}

function validatePeriodInput(input: AccountingPeriodInput) {
  const name = cleanText(input.name);
  const periodType = input.period_type;
  const startDate = cleanDate(input.start_date);
  const endDate = cleanDate(input.end_date);
  const fiscalYear = cleanFiscalYear(input.fiscal_year);
  const notes = cleanText(input.notes).slice(0, 500) || null;

  if (!name) {
    return { ok: false as const, message: "El nombre del período es requerido." };
  }

  if (!startDate || !endDate) {
    return { ok: false as const, message: "Fecha inicial y fecha final son requeridas." };
  }

  if (startDate >= endDate) {
    return { ok: false as const, message: invalidDateMessage };
  }

  if (!periodTypes.has(periodType)) {
    return { ok: false as const, message: "Selecciona un tipo de período válido." };
  }

  if (fiscalYear < 2000 || fiscalYear > 2100) {
    return { ok: false as const, message: "El año fiscal debe ser válido." };
  }

  if (input.status && input.status !== "open") {
    return { ok: false as const, message: "Phase 2I-1 solo permite administrar períodos abiertos." };
  }

  return {
    ok: true as const,
    period: {
      name: name.slice(0, 140),
      period_type: periodType,
      start_date: startDate,
      end_date: endDate,
      status: "open" as const,
      fiscal_year: fiscalYear,
      notes,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
    },
  };
}

async function findOverlappingPeriod(input: { id?: string; start_date: string; end_date: string }) {
  const supabase = await getSupabaseServerClient();
  let query = supabase
    .from("accounting_periods")
    .select("id, name")
    .lte("start_date", input.end_date)
    .gte("end_date", input.start_date)
    .limit(1);

  if (input.id) {
    query = query.neq("id", input.id);
  }

  const { data, error } = await query.returns<Array<{ id: string; name: string }>>();
  if (error) {
    throw new Error(error.message);
  }

  return data?.[0] ?? null;
}

export async function saveAccountingPeriodAction(input: AccountingPeriodInput): Promise<AccountingPeriodActionResult> {
  const profile = input.id ? await requirePermission("accounting:manage") : await requirePermission("accounting:create");
  const validation = validatePeriodInput(input);

  if (!validation.ok) {
    await auditInvalidAttempt(validation.message, input, profile.id);
    return { ok: false, message: validation.message };
  }

  const overlapping = await findOverlappingPeriod({ id: input.id, start_date: validation.period.start_date, end_date: validation.period.end_date });
  if (overlapping) {
    await auditInvalidAttempt(overlapMessage, input, profile.id);
    return { ok: false, message: overlapMessage };
  }

  const supabase = await getSupabaseServerClient();

  if (input.id) {
    const { data: previous, error: previousError } = await supabase
      .from("accounting_periods")
      .select("id, name, period_type, start_date, end_date, status, fiscal_year, notes")
      .eq("id", input.id)
      .maybeSingle<Pick<AccountingPeriod, "id" | "name" | "period_type" | "start_date" | "end_date" | "status" | "fiscal_year" | "notes">>();

    if (previousError) {
      return { ok: false, message: previousError.message };
    }

    if (!previous) {
      return { ok: false, message: "El período contable no existe." };
    }

    if (previous.status !== "open") {
      return { ok: false, message: "Los períodos cerrados no pueden editarse en esta fase." };
    }

    const { error } = await supabase.from("accounting_periods").update(validation.period).eq("id", input.id);
    if (error) {
      return { ok: false, message: error.message };
    }

    await writeAuditLog({
      tableName: "accounting_periods",
      recordId: input.id,
      action: "accounting.period.updated",
      oldData: previous,
      newData: validation.period,
    });
    await logAccountingPeriodEvent({
      eventType: "period.updated",
      entityId: input.id,
      metadata: validation.period,
      createdBy: profile.id,
    });
  } else {
    const { data, error } = await supabase
      .from("accounting_periods")
      .insert({ ...validation.period, created_by: profile.id })
      .select("id")
      .single<{ id: string }>();

    if (error) {
      return { ok: false, message: error.message };
    }

    await writeAuditLog({
      tableName: "accounting_periods",
      recordId: data.id,
      action: "accounting.period.created",
      newData: validation.period,
    });
    await logAccountingPeriodEvent({
      eventType: "period.created",
      entityId: data.id,
      metadata: validation.period,
      createdBy: profile.id,
    });
  }

  revalidatePath("/admin/periodos-contables");
  revalidatePath("/admin/contabilidad");
  revalidatePath("/admin/libro-mayor");
  revalidatePath("/admin/balance-comprobacion");
  revalidatePath("/admin/balance-general");
  revalidatePath("/admin/estado-resultados");

  return { ok: true, message: input.id ? "Período contable actualizado." : "Período contable creado." };
}

