"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { scanFinancialEventsDryRun } from "@/services/accounting/financial-event-engine";
import { generateJournalDraftFromFinancialEvent } from "@/services/accounting/journal-draft-generator";
import { processReceivablePaymentAccountingOutbox } from "@/services/accounting/receivable-payment-outbox";
import {
  applyChartOfAccountsImport,
  logAccountingCatalogEvent,
  parseAndValidateChartOfAccountsWorkbook,
} from "@/services/supabase/accounting-catalog.service";
import {
  getAccountingAccountSaveErrorMessage,
  validateAccountingAccountParent,
} from "@/services/supabase/accounting-account.service";
import { isAccountingAutomationMode, isAccountingMappingType } from "@/services/supabase/accounting-config.service";
import type {
  AccountingAccountInput,
  JournalDraftUpdateInput,
  JournalEntryInput,
  JournalEntryLineInput,
} from "@/types/accounting";
import type { ChartOfAccountsImportActionState } from "@/types/accounting-catalog";
import type { AccountingMappingInput, AutomationMode } from "@/types/financial-center";
import { uuidLike } from "@/utils/validation";

type AccountingMutationResult = {
  ok: boolean;
  message: string;
  version?: number;
  journalEntryId?: string;
};

type FinancialEventScanActionResult = AccountingMutationResult & {
  summary?: Awaited<ReturnType<typeof scanFinancialEventsDryRun>>;
};

type JournalDraftGenerationActionResult = AccountingMutationResult & {
  journalEntryId?: string;
};

const accountTypes = new Set(["asset", "liability", "equity", "revenue", "cost", "expense"]);
const normalBalances = new Set(["debit", "credit"]);

async function accountingRequestContext() {
  const requestHeaders = await headers();
  return {
    actorIp: requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || requestHeaders.get("x-real-ip") || null,
    userAgent: requestHeaders.get("user-agent")?.slice(0, 500) || null,
  };
}

function accountingRpcMessage(error: { message: string; code?: string } | null, fallback: string) {
  if (!error) return fallback;
  if (error.code === "40001" || error.message.includes("modificada por otro usuario")) {
    return "La partida fue modificada por otro usuario. Recargue la informacion antes de continuar.";
  }
  return error.message || fallback;
}


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

export async function importChartOfAccountsAction(
  _previousState: ChartOfAccountsImportActionState,
  formData: FormData,
): Promise<ChartOfAccountsImportActionState> {
  const profile = await requirePermission("accounting:manage");
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return { ok: false, message: "Selecciona un archivo Excel .xlsx.", errors: ["Selecciona un archivo Excel .xlsx."] };
  }

  await writeAuditLog({
    tableName: "accounting_accounts",
    action: "accounting.chart_import.attempted",
    newData: { fileName: file.name, fileSize: file.size },
  });
  await logAccountingCatalogEvent({
    eventType: "chart_import.attempted",
    metadata: { fileName: file.name, fileSize: file.size },
    createdBy: profile.id,
  });

  try {
    const validation = await parseAndValidateChartOfAccountsWorkbook(file);

    if (!validation.ok) {
      await writeAuditLog({
        tableName: "accounting_accounts",
        action: "accounting.chart_import.failed",
        newData: { fileName: file.name, errors: validation.errors.length, rows: validation.rows.length },
      });
      await logAccountingCatalogEvent({
        eventType: "chart_import.failed",
        metadata: { fileName: file.name, errors: validation.errors.length, rows: validation.rows.length },
        createdBy: profile.id,
      });

      return {
        ok: false,
        message: "Errores encontrados. No se importó ninguna cuenta.",
        errors: validation.errors,
      };
    }

    const summary = await applyChartOfAccountsImport(validation.rows, profile.id);

    await writeAuditLog({
      tableName: "accounting_accounts",
      action: "accounting.chart_import.completed",
      newData: { fileName: file.name, ...summary },
    });
    await logAccountingCatalogEvent({
      eventType: "chart_import.completed",
      metadata: { fileName: file.name, ...summary },
      createdBy: profile.id,
    });

    revalidatePath("/admin/contabilidad");
    return {
      ok: true,
      message: "Importación completada.",
      errors: [],
      summary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo importar el catálogo de cuentas.";
    await writeAuditLog({
      tableName: "accounting_accounts",
      action: "accounting.chart_import.failed",
      newData: { fileName: file.name, error: message },
    });
    await logAccountingCatalogEvent({
      eventType: "chart_import.failed",
      metadata: { fileName: file.name, error: message },
      createdBy: profile.id,
    });

    return { ok: false, message: "Errores encontrados. No se importó ninguna cuenta.", errors: [message] };
  }
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
export async function scanFinancialEventsAction(): Promise<FinancialEventScanActionResult> {
  const profile = await requirePermission("accounting:manage");
  const summary = await scanFinancialEventsDryRun(profile.id);

  revalidatePath("/admin/contabilidad");

  return {
    ok: true,
    message: `${summary.message} Insertados: ${summary.inserted}. Duplicados: ${summary.skippedDuplicate}. Pendientes: ${summary.pending}. Listos: ${summary.ready}.`,
    summary,
  };
}

export async function generateJournalDraftFromFinancialEventAction(eventId: string): Promise<JournalDraftGenerationActionResult> {
  const profile = await requirePermission("accounting:manage");
  const result = await generateJournalDraftFromFinancialEvent(eventId, profile.id);

  revalidatePath("/admin/contabilidad");

  return {
    ok: result.ok,
    message: result.message,
    journalEntryId: result.journalEntryId,
  };
}

export async function retryReceivablePaymentAccountingAction(outboxId: string): Promise<AccountingMutationResult> {
  const profile = await requirePermission("accounting:manage");
  const validatedId = uuidLike(outboxId, "ID de outbox contable");
  if (!validatedId.ok) return { ok: false, message: validatedId.message };

  const result = await processReceivablePaymentAccountingOutbox({
    outboxId: validatedId.value,
    actorId: profile.id,
    forceRetry: true,
  });

  revalidatePath("/admin/contabilidad");
  revalidatePath("/admin/cuentas-por-cobrar");
  revalidatePath("/admin/crm");

  if (result.draftStatus === "borrador") {
    return { ok: true, message: "La partida contable fue creada en borrador." };
  }
  if (result.reason === "mapping_missing") {
    return { ok: true, message: "El evento continúa pendiente porque falta un mapeo contable." };
  }
  if (result.reason === "period_closed") {
    return { ok: true, message: "El evento continúa pendiente porque el período contable está cerrado." };
  }
  if (result.reason === "payment_voided") {
    return { ok: false, message: "Un abono anulado no puede volver a procesarse como movimiento normal." };
  }
  return {
    ok: result.ok,
    message: result.ok
      ? "El evento contable fue reconciliado sin duplicados."
      : "El procesamiento contable continúa pendiente; puede reintentarse de forma segura.",
  };
}

export async function saveAccountingAccountAction(input: AccountingAccountInput): Promise<AccountingMutationResult> {
  const profile = input.id ? await requirePermission("accounting:manage") : await requirePermission("accounting:create");
  const validation = validateAccountInput(input);
  if (!validation.ok) {
    return { ok: false, message: validation.message };
  }

  const parentValidation = await validateAccountingAccountParent({
    accountId: input.id ?? null,
    parentId: validation.account.parent_id,
  });
  if (!parentValidation.ok) {
    return { ok: false, message: parentValidation.message };
  }

  const accountPayload = { ...validation.account, parent_id: parentValidation.parentId };

  const supabase = await getSupabaseServerClient();
  if (input.id) {
    const { data: previous } = await supabase
      .from("accounting_accounts")
      .select("id, code, name, type, parent_id, normal_balance, is_active, description")
      .eq("id", input.id)
      .maybeSingle();
    const { error } = await supabase.from("accounting_accounts").update(accountPayload).eq("id", input.id);

    if (error) {
      return { ok: false, message: getAccountingAccountSaveErrorMessage(error, { hasParent: Boolean(accountPayload.parent_id) }) };
    }

    await writeAuditLog({
      tableName: "accounting_accounts",
      recordId: input.id,
      action: "accounting.account.updated",
      oldData: previous ?? null,
      newData: accountPayload,
    });
    await logAccountingEvent({
      eventType: "account.updated",
      entityType: "accounting_accounts",
      entityId: input.id,
      metadata: accountPayload,
      createdBy: profile.id,
    });
  } else {
    const { data, error } = await supabase
      .from("accounting_accounts")
      .insert({ ...accountPayload, created_by: profile.id })
      .select("id")
      .single<{ id: string }>();

    if (error) {
      return { ok: false, message: getAccountingAccountSaveErrorMessage(error, { hasParent: Boolean(accountPayload.parent_id) }) };
    }

    await writeAuditLog({
      tableName: "accounting_accounts",
      recordId: data.id,
      action: "accounting.account.created",
      newData: accountPayload,
    });
    await logAccountingEvent({
      eventType: "account.created",
      entityType: "accounting_accounts",
      entityId: data.id,
      metadata: accountPayload,
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
  await requirePermission("accounting:create");
  if (input.id) {
    return { ok: false, message: "La edición de borradores debe usar el flujo transaccional autorizado." };
  }

  const description = cleanText(input.description);
  const entryDate = cleanDate(input.entry_date);
  if (!entryDate || description.length < 3) {
    return { ok: false, message: "Ingresa fecha y descripción de la partida." };
  }

  const normalized = normalizeLines(input.lines);
  if (!normalized.ok) return { ok: false, message: normalized.message };
  const accountsValidation = await validateActiveAccounts(normalized.lines.map((line) => line.account_id));
  if (!accountsValidation.ok) return { ok: false, message: accountsValidation.message };
  const totals = lineTotals(normalized.lines);
  if (totals.debit <= 0 || totals.debit !== totals.credit) {
    return { ok: false, message: "La partida debe estar cuadrada: total débito igual a total crédito." };
  }

  const requestContext = await accountingRequestContext();
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_manual_journal_draft", {
    entry_date_value: entryDate,
    description_value: description,
    lines_data: normalized.lines,
    actor_ip: requestContext.actorIp,
    actor_user_agent: requestContext.userAgent,
  });
  if (error) return { ok: false, message: accountingRpcMessage(error, "No se pudo crear la partida.") };

  const result = data as { journal_entry_id?: string; version?: number } | null;
  revalidatePath("/admin/contabilidad");
  return {
    ok: true,
    message: "Partida guardada como borrador.",
    journalEntryId: result?.journal_entry_id,
    version: result?.version,
  };
}

export async function updateJournalDraftAction(input: JournalDraftUpdateInput): Promise<AccountingMutationResult> {
  const profile = await requirePermission("accounting:edit_draft_entries");
  const description = cleanText(input.description);
  const entryDate = cleanDate(input.entry_date);
  const reason = cleanText(input.edit_reason);
  if (!input.id || !Number.isInteger(input.expected_version) || input.expected_version < 1) {
    return { ok: false, message: "La versión de la partida no es válida. Recarga la información." };
  }
  if (!entryDate || description.length < 3) return { ok: false, message: "Ingresa fecha y descripción de la partida." };
  if (reason.length < 10 || reason.length > 1000) return { ok: false, message: "Ingresa un motivo de edición de al menos 10 caracteres." };
  const normalized = normalizeLines(input.lines);
  if (!normalized.ok) return { ok: false, message: normalized.message };
  const totals = lineTotals(normalized.lines);
  if (totals.debit <= 0 || totals.debit !== totals.credit) {
    return { ok: false, message: "No puede guardar una partida desbalanceada." };
  }
  const accountsValidation = await validateActiveAccounts(normalized.lines.map((line) => line.account_id));
  if (!accountsValidation.ok) return { ok: false, message: accountsValidation.message };

  const requestContext = await accountingRequestContext();
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_journal_draft", {
    target_entry_id: input.id,
    expected_version: input.expected_version,
    entry_date_value: entryDate,
    description_value: description,
    lines_data: normalized.lines,
    edit_reason: reason,
    actor_ip: requestContext.actorIp,
    actor_user_agent: requestContext.userAgent,
  });
  if (error) {
    if (error.code === "40001" || error.message.includes("modificada por otro usuario")) {
      await writeAuditLog({
        tableName: "journal_entries", recordId: input.id, action: "accounting_entry_update_conflict",
        newData: { operation: "edit", expected_version: input.expected_version, actor_id: profile.id, actor_role: profile.role },
        ipAddress: requestContext.actorIp, userAgent: requestContext.userAgent,
      });
    }
    return { ok: false, message: accountingRpcMessage(error, "No se pudo editar la partida.") };
  }
  const result = data as { version?: number } | null;
  revalidatePath("/admin/contabilidad");
  revalidatePath(`/admin/contabilidad/partidas/${input.id}/editar`);
  return { ok: true, message: "Partida actualizada. Continúa en borrador.", version: result?.version };
}

export async function recalculateJournalDraftFromSourceAction(
  entryId: string,
  expectedVersion: number,
  reason: string,
): Promise<AccountingMutationResult> {
  const profile = await requirePermission("accounting:edit_draft_entries");
  const cleanReason = cleanText(reason);
  if (cleanReason.length < 10 || cleanReason.length > 1000) return { ok: false, message: "Ingresa un motivo de recálculo de al menos 10 caracteres." };
  const requestContext = await accountingRequestContext();
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("recalculate_journal_draft_from_source", {
    target_entry_id: entryId,
    expected_version: expectedVersion,
    recalculate_reason: cleanReason,
    actor_ip: requestContext.actorIp,
    actor_user_agent: requestContext.userAgent,
  });
  if (error) {
    if (error.code === "40001" || error.message.includes("modificada por otro usuario")) {
      await writeAuditLog({
        tableName: "journal_entries", recordId: entryId, action: "accounting_entry_update_conflict",
        newData: { operation: "recalculate", expected_version: expectedVersion, actor_id: profile.id, actor_role: profile.role },
        ipAddress: requestContext.actorIp, userAgent: requestContext.userAgent,
      });
    }
    return { ok: false, message: accountingRpcMessage(error, "No se pudo recalcular la partida.") };
  }
  const result = data as { version?: number } | null;
  revalidatePath("/admin/contabilidad");
  revalidatePath(`/admin/contabilidad/partidas/${entryId}/editar`);
  return { ok: true, message: "Partida recalculada desde el documento origen.", version: result?.version };
}

export async function postJournalEntryAction(entryId: string, expectedVersion: number): Promise<AccountingMutationResult> {
  const profile = await requirePermission("accounting:post");
  const requestContext = await accountingRequestContext();
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("post_journal_entry", {
    target_entry_id: entryId,
    expected_version: expectedVersion,
    actor_ip: requestContext.actorIp,
    actor_user_agent: requestContext.userAgent,
  });

  if (error) {
    if (error.code === "40001" || error.message.includes("modificada por otro usuario")) {
      await writeAuditLog({
        tableName: "journal_entries",
        recordId: entryId,
        action: "accounting_entry_update_conflict",
        newData: { operation: "publish", expected_version: expectedVersion, actor_id: profile.id, actor_role: profile.role },
        ipAddress: requestContext.actorIp,
        userAgent: requestContext.userAgent,
      });
    }
    return { ok: false, message: accountingRpcMessage(error, "No se pudo publicar la partida.") };
  }

  const result = data as { version?: number } | null;
  revalidatePath("/admin/contabilidad");
  revalidatePath(`/admin/contabilidad/partidas/${entryId}/editar`);
  return { ok: true, message: "Partida publicada correctamente.", version: result?.version };
}

export async function reverseJournalEntryAction(entryId: string): Promise<AccountingMutationResult> {
  await requirePermission("accounting:reverse");
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("reverse_journal_entry", { target_entry_id: entryId });
  if (error) return { ok: false, message: accountingRpcMessage(error, "No se pudo reversar la partida.") };

  revalidatePath("/admin/contabilidad");
  return { ok: true, message: "Partida reversada correctamente." };
}
