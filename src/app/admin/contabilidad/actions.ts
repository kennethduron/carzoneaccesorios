"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { isAccountingAutomationMode, isAccountingMappingType } from "@/services/supabase/accounting-config.service";
import type {
  AccountingAccountInput,
  JournalEntryInput,
  JournalEntryLineInput,
  JournalEntryStatus,
} from "@/types/accounting";
import type { AccountingMappingInput, AutomationMode } from "@/types/financial-center";

type AccountingMutationResult = {
  ok: boolean;
  message: string;
};

type EntryForMutation = {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  status: JournalEntryStatus;
  source_type: string | null;
  source_id: string | null;
  created_by: string;
  posted_by: string | null;
  posted_at: string | null;
  reversed_entry_id: string | null;
};

type LineForMutation = {
  id: string;
  journal_entry_id: string;
  account_id: string;
  debit: unknown;
  credit: unknown;
  description: string | null;
};

const accountTypes = new Set(["asset", "liability", "equity", "revenue", "cost", "expense"]);
const normalBalances = new Set(["debit", "credit"]);

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanDate(value: unknown) {
  const text = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function cleanMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toAmount(value: unknown) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

function nextEntryNumber() {
  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll("-", "");
  const suffix = Date.now().toString().slice(-6);
  return `PC-${dateKey}-${suffix}`;
}

async function logAccountingEvent(input: {
  eventType: string;
  entityType: string;
  entityId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}) {
  const supabase = await getSupabaseServerClient();
  await supabase.from("accounting_event_log").insert({
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    source_type: input.sourceType ?? null,
    source_id: input.sourceId ?? null,
    metadata: input.metadata ?? {},
    created_by: input.createdBy ?? null,
  });
}

function validateAccountInput(input: AccountingAccountInput) {
  const code = cleanText(input.code).toUpperCase();
  const name = cleanText(input.name);
  const description = cleanText(input.description) || null;
  const type = input.type;
  const normalBalance = input.normal_balance;

  if (code.length < 1 || code.length > 32) {
    return { ok: false as const, message: "El código debe tener entre 1 y 32 caracteres." };
  }

  if (name.length < 2 || name.length > 140) {
    return { ok: false as const, message: "El nombre debe tener entre 2 y 140 caracteres." };
  }

  if (!accountTypes.has(type)) {
    return { ok: false as const, message: "Selecciona un tipo de cuenta válido." };
  }

  if (!normalBalances.has(normalBalance)) {
    return { ok: false as const, message: "Selecciona una naturaleza válida." };
  }

  if (input.parent_id && input.id && input.parent_id === input.id) {
    return { ok: false as const, message: "Una cuenta no puede ser su propia cuenta padre." };
  }

  return {
    ok: true as const,
    account: {
      code,
      name,
      type,
      parent_id: input.parent_id || null,
      normal_balance: normalBalance,
      is_active: input.is_active ?? true,
      description,
    },
  };
}

function normalizeLines(lines: JournalEntryLineInput[]) {
  const normalized = lines
    .map((line) => ({
      account_id: cleanText(line.account_id),
      debit: toAmount(line.debit),
      credit: toAmount(line.credit),
      description: cleanText(line.description) || null,
      customer_id: line.customer_id || null,
      vendor_id: cleanText(line.vendor_id) || null,
      product_id: line.product_id || null,
    }))
    .filter((line) => line.account_id || line.debit > 0 || line.credit > 0 || line.description);

  if (normalized.length < 2) {
    return { ok: false as const, message: "Agrega al menos dos líneas contables válidas." };
  }

  for (const line of normalized) {
    if (!line.account_id) {
      return { ok: false as const, message: "Cada línea debe tener una cuenta contable." };
    }

    if (line.debit > 0 && line.credit > 0) {
      return { ok: false as const, message: "Una línea no puede tener débito y crédito al mismo tiempo." };
    }

    if (line.debit <= 0 && line.credit <= 0) {
      return { ok: false as const, message: "Cada línea debe tener débito o crédito mayor que cero." };
    }
  }

  return { ok: true as const, lines: normalized };
}

async function validateActiveAccounts(accountIds: string[]) {
  const supabase = await getSupabaseServerClient();
  const uniqueIds = [...new Set(accountIds)];
  const { data, error } = await supabase
    .from("accounting_accounts")
    .select("id, is_active")
    .in("id", uniqueIds)
    .returns<Array<{ id: string; is_active: boolean }>>();

  if (error) {
    return { ok: false as const, message: error.message };
  }

  const activeIds = new Set((data ?? []).filter((account) => account.is_active).map((account) => account.id));
  if (activeIds.size !== uniqueIds.length) {
    return { ok: false as const, message: "Todas las líneas deben usar cuentas contables activas." };
  }

  return { ok: true as const };
}

async function getEntryWithLines(entryId: string) {
  const supabase = await getSupabaseServerClient();
  const [{ data: entry, error: entryError }, { data: lines, error: linesError }] = await Promise.all([
    supabase
      .from("journal_entries")
      .select("id, entry_number, entry_date, description, status, source_type, source_id, created_by, posted_by, posted_at, reversed_entry_id")
      .eq("id", entryId)
      .maybeSingle<EntryForMutation>(),
    supabase
      .from("journal_entry_lines")
      .select("id, journal_entry_id, account_id, debit, credit, description")
      .eq("journal_entry_id", entryId)
      .returns<LineForMutation[]>(),
  ]);

  if (entryError) {
    return { ok: false as const, message: entryError.message };
  }

  if (linesError) {
    return { ok: false as const, message: linesError.message };
  }

  if (!entry) {
    return { ok: false as const, message: "La partida contable no existe." };
  }

  return { ok: true as const, entry, lines: lines ?? [] };
}

function lineTotals(lines: Array<{ debit: unknown; credit: unknown }>) {
  const debit = lines.reduce((sum, line) => sum + toAmount(line.debit), 0);
  const credit = lines.reduce((sum, line) => sum + toAmount(line.credit), 0);
  return {
    debit: Math.round(debit * 100) / 100,
    credit: Math.round(credit * 100) / 100,
  };
}

function validateMappingInput(input: AccountingMappingInput) {
  const mappingType = cleanText(input.mapping_type);
  const sourceKey = cleanText(input.source_key).toLowerCase();
  const accountId = cleanText(input.account_id);
  const effectiveFrom = cleanDate(input.effective_from);
  const effectiveTo = cleanDate(input.effective_to);
  const priority = Number.isFinite(Number(input.priority ?? 100)) ? Math.floor(Number(input.priority ?? 100)) : 100;

  if (!isAccountingMappingType(mappingType)) {
    return { ok: false as const, message: "Selecciona un tipo de mapeo válido." };
  }

  if (sourceKey.length < 1 || sourceKey.length > 120) {
    return { ok: false as const, message: "La clave de origen debe tener entre 1 y 120 caracteres." };
  }

  if (!accountId) {
    return { ok: false as const, message: "Selecciona una cuenta contable." };
  }

  if (priority < 1 || priority > 10000) {
    return { ok: false as const, message: "La prioridad debe estar entre 1 y 10000." };
  }

  if (input.effective_from && !effectiveFrom) {
    return { ok: false as const, message: "La fecha inicial no es válida." };
  }

  if (input.effective_to && !effectiveTo) {
    return { ok: false as const, message: "La fecha final no es válida." };
  }

  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
    return { ok: false as const, message: "La fecha final no puede ser menor que la fecha inicial." };
  }

  return {
    ok: true as const,
    mapping: {
      mapping_type: mappingType,
      source_key: sourceKey,
      account_id: accountId,
      priority,
      is_active: input.is_active ?? true,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      metadata: cleanMetadata(input.metadata),
    },
  };
}

async function validateMappingAccount(accountId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounting_accounts")
    .select("id, is_active")
    .eq("id", accountId)
    .maybeSingle<{ id: string; is_active: boolean }>();

  if (error) {
    return { ok: false as const, message: error.message };
  }

  if (!data) {
    return { ok: false as const, message: "La cuenta contable seleccionada no existe." };
  }

  if (!data.is_active) {
    return { ok: false as const, message: "La cuenta contable seleccionada está inactiva." };
  }

  return { ok: true as const };
}

export async function saveAccountingMappingAction(input: AccountingMappingInput): Promise<AccountingMutationResult> {
  const profile = await requirePermission("accounting:settings");
  const validation = validateMappingInput(input);
  if (!validation.ok) {
    return { ok: false, message: validation.message };
  }

  const accountValidation = await validateMappingAccount(validation.mapping.account_id);
  if (!accountValidation.ok) {
    return { ok: false, message: accountValidation.message };
  }

  const supabase = await getSupabaseServerClient();
  if (input.id) {
    const { data: previous } = await supabase
      .from("accounting_mappings")
      .select("id, mapping_type, source_key, account_id, priority, is_active, effective_from, effective_to, metadata")
      .eq("id", input.id)
      .maybeSingle();
    const { error } = await supabase.from("accounting_mappings").update(validation.mapping).eq("id", input.id);

    if (error) {
      return { ok: false, message: error.message };
    }

    await writeAuditLog({
      tableName: "accounting_mappings",
      recordId: input.id,
      action: "accounting.mapping.updated",
      oldData: previous ?? null,
      newData: validation.mapping,
    });
    await logAccountingEvent({
      eventType: "mapping.updated",
      entityType: "accounting_mappings",
      entityId: input.id,
      metadata: validation.mapping,
      createdBy: profile.id,
    });
  } else {
    const { data, error } = await supabase
      .from("accounting_mappings")
      .insert({ ...validation.mapping, created_by: profile.id })
      .select("id")
      .single<{ id: string }>();

    if (error) {
      return { ok: false, message: error.message };
    }

    await writeAuditLog({
      tableName: "accounting_mappings",
      recordId: data.id,
      action: "accounting.mapping.created",
      newData: validation.mapping,
    });
    await logAccountingEvent({
      eventType: "mapping.created",
      entityType: "accounting_mappings",
      entityId: data.id,
      metadata: validation.mapping,
      createdBy: profile.id,
    });
  }

  revalidatePath("/admin/contabilidad");
  return { ok: true, message: input.id ? "Mapeo contable actualizado." : "Mapeo contable creado." };
}

export async function toggleAccountingMappingAction(mappingId: string, isActive: boolean): Promise<AccountingMutationResult> {
  const profile = await requirePermission("accounting:settings");
  const supabase = await getSupabaseServerClient();
  const { data: previous } = await supabase
    .from("accounting_mappings")
    .select("id, mapping_type, source_key, account_id, is_active")
    .eq("id", mappingId)
    .maybeSingle();
  const { error } = await supabase.from("accounting_mappings").update({ is_active: isActive }).eq("id", mappingId);

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "accounting_mappings",
    recordId: mappingId,
    action: isActive ? "accounting.mapping.activated" : "accounting.mapping.deactivated",
    oldData: previous ?? null,
    newData: { is_active: isActive },
  });
  await logAccountingEvent({
    eventType: isActive ? "mapping.activated" : "mapping.deactivated",
    entityType: "accounting_mappings",
    entityId: mappingId,
    metadata: { is_active: isActive },
    createdBy: profile.id,
  });

  revalidatePath("/admin/contabilidad");
  return { ok: true, message: isActive ? "Mapeo activado." : "Mapeo desactivado." };
}

export async function updateAutomationModeAction(mode: AutomationMode): Promise<AccountingMutationResult> {
  const profile = await requirePermission("accounting:settings");
  if (mode === "auto_post") {
    return { ok: false, message: "El modo de publicación automática aún no está disponible." };
  }

  if (!isAccountingAutomationMode(mode)) {
    return { ok: false, message: "Selecciona un modo de automatización válido." };
  }

  const supabase = await getSupabaseServerClient();
  const payload = {
    key: "automation_mode",
    value: { mode },
    description: "Controla el modo de automatización contable futura.",
    updated_by: profile.id,
  };

  const { data: previous } = await supabase
    .from("accounting_automation_settings")
    .select("id, key, value, description")
    .eq("key", "automation_mode")
    .maybeSingle<{ id: string; key: string; value: Record<string, unknown>; description: string | null }>();
  const { data, error } = await supabase
    .from("accounting_automation_settings")
    .upsert(payload, { onConflict: "key" })
    .select("id")
    .single<{ id: string }>();

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "accounting_automation_settings",
    recordId: data.id,
    action: "accounting.automation_mode.updated",
    oldData: previous ?? null,
    newData: payload,
  });
  await logAccountingEvent({
    eventType: "automation_mode.updated",
    entityType: "accounting_automation_settings",
    entityId: data.id,
    metadata: { mode },
    createdBy: profile.id,
  });

  revalidatePath("/admin/contabilidad");
  return { ok: true, message: "Modo de automatización actualizado." };
}
export async function saveAccountingAccountAction(input: AccountingAccountInput): Promise<AccountingMutationResult> {
  const profile = input.id ? await requirePermission("accounting:manage") : await requirePermission("accounting:create");
  const validation = validateAccountInput(input);
  if (!validation.ok) {
    return { ok: false, message: validation.message };
  }

  const supabase = await getSupabaseServerClient();
  if (input.id) {
    const { data: previous } = await supabase
      .from("accounting_accounts")
      .select("id, code, name, type, parent_id, normal_balance, is_active, description")
      .eq("id", input.id)
      .maybeSingle();
    const { error } = await supabase.from("accounting_accounts").update(validation.account).eq("id", input.id);

    if (error) {
      return { ok: false, message: error.message };
    }

    await writeAuditLog({
      tableName: "accounting_accounts",
      recordId: input.id,
      action: "accounting.account.updated",
      oldData: previous ?? null,
      newData: validation.account,
    });
    await logAccountingEvent({
      eventType: "account.updated",
      entityType: "accounting_accounts",
      entityId: input.id,
      metadata: validation.account,
      createdBy: profile.id,
    });
  } else {
    const { data, error } = await supabase
      .from("accounting_accounts")
      .insert({ ...validation.account, created_by: profile.id })
      .select("id")
      .single<{ id: string }>();

    if (error) {
      return { ok: false, message: error.message };
    }

    await writeAuditLog({
      tableName: "accounting_accounts",
      recordId: data.id,
      action: "accounting.account.created",
      newData: validation.account,
    });
    await logAccountingEvent({
      eventType: "account.created",
      entityType: "accounting_accounts",
      entityId: data.id,
      metadata: validation.account,
      createdBy: profile.id,
    });
  }

  revalidatePath("/admin/contabilidad");
  return { ok: true, message: input.id ? "Cuenta contable actualizada." : "Cuenta contable creada." };
}

export async function toggleAccountingAccountAction(accountId: string, isActive: boolean): Promise<AccountingMutationResult> {
  const profile = await requirePermission("accounting:manage");
  const supabase = await getSupabaseServerClient();
  const { data: previous } = await supabase
    .from("accounting_accounts")
    .select("id, code, name, is_active")
    .eq("id", accountId)
    .maybeSingle();
  const { error } = await supabase.from("accounting_accounts").update({ is_active: isActive }).eq("id", accountId);

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "accounting_accounts",
    recordId: accountId,
    action: isActive ? "accounting.account.activated" : "accounting.account.deactivated",
    oldData: previous ?? null,
    newData: { is_active: isActive },
  });
  await logAccountingEvent({
    eventType: isActive ? "account.activated" : "account.deactivated",
    entityType: "accounting_accounts",
    entityId: accountId,
    metadata: { is_active: isActive },
    createdBy: profile.id,
  });

  revalidatePath("/admin/contabilidad");
  return { ok: true, message: isActive ? "Cuenta activada." : "Cuenta desactivada." };
}

export async function saveJournalDraftAction(input: JournalEntryInput): Promise<AccountingMutationResult> {
  const profile = await requirePermission("accounting:create");
  const description = cleanText(input.description);
  const entryDate = cleanText(input.entry_date);

  if (!entryDate || description.length < 3) {
    return { ok: false, message: "Ingresa fecha y descripción de la partida." };
  }

  const normalized = normalizeLines(input.lines);
  if (!normalized.ok) {
    return { ok: false, message: normalized.message };
  }

  const accountsValidation = await validateActiveAccounts(normalized.lines.map((line) => line.account_id));
  if (!accountsValidation.ok) {
    return { ok: false, message: accountsValidation.message };
  }

  const supabase = await getSupabaseServerClient();
  let entryId = input.id;

  if (entryId) {
    const existing = await getEntryWithLines(entryId);
    if (!existing.ok) {
      return { ok: false, message: existing.message };
    }

    if (existing.entry.status !== "borrador") {
      return { ok: false, message: "Solo se pueden editar partidas en borrador." };
    }

    const { error: entryError } = await supabase
      .from("journal_entries")
      .update({
        entry_date: entryDate,
        description,
        source_type: cleanText(input.source_type) || null,
        source_id: cleanText(input.source_id) || null,
      })
      .eq("id", entryId);

    if (entryError) {
      return { ok: false, message: entryError.message };
    }

    const { error: deleteError } = await supabase.from("journal_entry_lines").delete().eq("journal_entry_id", entryId);
    if (deleteError) {
      return { ok: false, message: deleteError.message };
    }
  } else {
    const { data, error } = await supabase
      .from("journal_entries")
      .insert({
        entry_number: nextEntryNumber(),
        entry_date: entryDate,
        description,
        status: "borrador",
        source_type: cleanText(input.source_type) || null,
        source_id: cleanText(input.source_id) || null,
        created_by: profile.id,
      })
      .select("id")
      .single<{ id: string }>();

    if (error) {
      return { ok: false, message: error.message };
    }

    entryId = data.id;
  }

  const { error: lineError } = await supabase.from("journal_entry_lines").insert(
    normalized.lines.map((line) => ({
      journal_entry_id: entryId,
      ...line,
    })),
  );

  if (lineError) {
    return { ok: false, message: lineError.message };
  }

  await writeAuditLog({
    tableName: "journal_entries",
    recordId: entryId,
    action: input.id ? "accounting.journal_draft.updated" : "accounting.journal_draft.created",
    newData: { entry_date: entryDate, description, lines: normalized.lines.length },
  });
  await logAccountingEvent({
    eventType: input.id ? "journal_draft.updated" : "journal_draft.created",
    entityType: "journal_entries",
    entityId: entryId,
    metadata: { entry_date: entryDate, description, lines: normalized.lines.length },
    createdBy: profile.id,
  });

  revalidatePath("/admin/contabilidad");
  return { ok: true, message: "Partida guardada como borrador." };
}

export async function postJournalEntryAction(entryId: string): Promise<AccountingMutationResult> {
  const profile = await requirePermission("accounting:post");
  const existing = await getEntryWithLines(entryId);
  if (!existing.ok) {
    return { ok: false, message: existing.message };
  }

  if (existing.entry.status !== "borrador") {
    return { ok: false, message: "Solo se pueden publicar partidas en borrador." };
  }

  const normalized = normalizeLines(
    existing.lines.map((line) => ({
      account_id: line.account_id,
      debit: toAmount(line.debit),
      credit: toAmount(line.credit),
      description: line.description,
    })),
  );
  if (!normalized.ok) {
    return { ok: false, message: normalized.message };
  }

  const accountsValidation = await validateActiveAccounts(normalized.lines.map((line) => line.account_id));
  if (!accountsValidation.ok) {
    return { ok: false, message: accountsValidation.message };
  }

  const totals = lineTotals(existing.lines);
  if (totals.debit <= 0 || totals.credit <= 0 || totals.debit !== totals.credit) {
    return { ok: false, message: "La partida debe estar cuadrada: total débito igual a total crédito." };
  }

  const supabase = await getSupabaseServerClient();
  const postedAt = new Date().toISOString();
  const { error } = await supabase
    .from("journal_entries")
    .update({ status: "publicada", posted_by: profile.id, posted_at: postedAt })
    .eq("id", entryId);

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "journal_entries",
    recordId: entryId,
    action: "accounting.journal_entry.posted",
    oldData: { status: existing.entry.status },
    newData: { status: "publicada", total_debit: totals.debit, total_credit: totals.credit },
  });
  await logAccountingEvent({
    eventType: "journal_entry.posted",
    entityType: "journal_entries",
    entityId: entryId,
    metadata: { total_debit: totals.debit, total_credit: totals.credit },
    createdBy: profile.id,
  });

  revalidatePath("/admin/contabilidad");
  return { ok: true, message: "Partida publicada correctamente." };
}

export async function reverseJournalEntryAction(entryId: string): Promise<AccountingMutationResult> {
  const profile = await requirePermission("accounting:reverse");
  const existing = await getEntryWithLines(entryId);
  if (!existing.ok) {
    return { ok: false, message: existing.message };
  }

  if (existing.entry.status !== "publicada") {
    return { ok: false, message: "Solo se pueden reversar partidas publicadas." };
  }

  const totals = lineTotals(existing.lines);
  if (totals.debit !== totals.credit || totals.debit <= 0) {
    return { ok: false, message: "La partida original no está cuadrada y no puede reversarse automáticamente." };
  }

  const supabase = await getSupabaseServerClient();
  const now = new Date().toISOString();
  const { data: reversal, error: reversalError } = await supabase
    .from("journal_entries")
    .insert({
      entry_number: nextEntryNumber(),
      entry_date: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date()),
      description: `Reverso de ${existing.entry.entry_number}: ${existing.entry.description}`,
      status: "borrador",
      source_type: "journal_reversal",
      source_id: existing.entry.id,
      created_by: profile.id,
    })
    .select("id")
    .single<{ id: string }>();

  if (reversalError) {
    return { ok: false, message: reversalError.message };
  }

  const { error: linesError } = await supabase.from("journal_entry_lines").insert(
    existing.lines.map((line) => ({
      journal_entry_id: reversal.id,
      account_id: line.account_id,
      debit: toAmount(line.credit),
      credit: toAmount(line.debit),
      description: line.description ? `Reverso: ${line.description}` : `Reverso de ${existing.entry.entry_number}`,
    })),
  );

  if (linesError) {
    return { ok: false, message: linesError.message };
  }

  const { error: postError } = await supabase
    .from("journal_entries")
    .update({ status: "publicada", posted_by: profile.id, posted_at: now })
    .eq("id", reversal.id);

  if (postError) {
    return { ok: false, message: postError.message };
  }

  const { error: originalError } = await supabase
    .from("journal_entries")
    .update({ status: "reversada", reversed_entry_id: reversal.id })
    .eq("id", existing.entry.id);

  if (originalError) {
    return { ok: false, message: originalError.message };
  }

  await writeAuditLog({
    tableName: "journal_entries",
    recordId: reversal.id,
    action: "accounting.journal_reversal.created",
    newData: {
      status: "publicada",
      original_entry_id: existing.entry.id,
      original_entry_number: existing.entry.entry_number,
      total_debit: totals.debit,
      total_credit: totals.credit,
    },
  });
  await logAccountingEvent({
    eventType: "journal_reversal.created",
    entityType: "journal_entries",
    entityId: reversal.id,
    sourceType: "journal_reversal",
    sourceId: existing.entry.id,
    metadata: {
      original_entry_id: existing.entry.id,
      original_entry_number: existing.entry.entry_number,
      total_debit: totals.debit,
      total_credit: totals.credit,
    },
    createdBy: profile.id,
  });

  await writeAuditLog({
    tableName: "journal_entries",
    recordId: existing.entry.id,
    action: "accounting.journal_entry.reversed",
    oldData: { status: existing.entry.status },
    newData: { status: "reversada", reversal_entry_id: reversal.id },
  });
  await logAccountingEvent({
    eventType: "journal_entry.reversed",
    entityType: "journal_entries",
    entityId: existing.entry.id,
    sourceType: "journal_reversal",
    sourceId: reversal.id,
    metadata: { original_entry_number: existing.entry.entry_number, reversal_entry_id: reversal.id },
    createdBy: profile.id,
  });

  revalidatePath("/admin/contabilidad");
  return { ok: true, message: "Partida reversada correctamente." };
}
