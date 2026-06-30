import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  AccountingAutomationSetting,
  AccountingMapping,
  AccountingMappingAccount,
  AutomationMode,
  FinancialCenterData,
  FinancialEvent,
  FinancialReadinessStatus,
  MappingReadinessItem,
  PeriodReadiness,
  RequiredMappingDefinition,
} from "@/types/financial-center";

type AccountingMappingRow = Omit<AccountingMapping, "account" | "metadata"> & {
  metadata: unknown;
  accounting_accounts: AccountingMappingAccount | null;
};

type FinancialEventRow = Omit<FinancialEvent, "source_snapshot" | "validation_errors" | "journal_entry"> & {
  source_snapshot: unknown;
  validation_errors: unknown;
  journal_entries: { id: string; entry_number: string; status: string } | null;
};

const automationModes = new Set<AutomationMode>(["disabled", "dry_run", "draft_only", "auto_post"]);

export const requiredAccountingMappings: RequiredMappingDefinition[] = [
  { key: "cash", label: "Caja", mappingType: "payment_method", sourceKey: "cash" },
  { key: "bank_transfer", label: "Banco / transferencia", mappingType: "payment_method", sourceKey: "bank_transfer" },
  { key: "card", label: "Cuenta puente de tarjeta", mappingType: "payment_method", sourceKey: "card" },
  { key: "accounts_receivable", label: "Cuenta por cobrar", mappingType: "receivable", sourceKey: "accounts_receivable" },
  { key: "sales_revenue", label: "Ingresos por ventas", mappingType: "revenue", sourceKey: "sales_revenue" },
  { key: "tax_payable", label: "Impuestos por pagar", mappingType: "tax", sourceKey: "tax_payable" },
  { key: "inventory_asset", label: "Inventario", mappingType: "inventory", sourceKey: "inventory_asset" },
  { key: "cost_of_goods_sold", label: "Costo de ventas", mappingType: "inventory", sourceKey: "cost_of_goods_sold" },
  { key: "suspense", label: "Cuenta transitoria", mappingType: "suspense", sourceKey: "suspense" },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeAutomationMode(setting: AccountingAutomationSetting | null): AutomationMode {
  const mode = asRecord(setting?.value).mode;
  return typeof mode === "string" && automationModes.has(mode as AutomationMode) ? (mode as AutomationMode) : "disabled";
}

function normalizeMapping(row: AccountingMappingRow): AccountingMapping {
  return {
    ...row,
    metadata: asRecord(row.metadata),
    account: row.accounting_accounts,
  };
}

function normalizeFinancialEvent(row: FinancialEventRow): FinancialEvent {
  const errors = Array.isArray(row.validation_errors) ? row.validation_errors : [];
  return {
    ...row,
    source_snapshot: asRecord(row.source_snapshot),
    validation_errors: errors,
    journal_entry: row.journal_entries,
  };
}

function buildReadinessItems(mappings: AccountingMapping[]): MappingReadinessItem[] {
  return requiredAccountingMappings.map((definition) => {
    const mapping = mappings.find(
      (item) =>
        item.is_active &&
        item.mapping_type === definition.mappingType &&
        item.source_key === definition.sourceKey,
    );

    if (!mapping) {
      return {
        ...definition,
        status: "pending",
        mappingId: null,
        account: null,
        message: "Cuenta no configurada",
      };
    }

    if (!mapping.account?.is_active) {
      return {
        ...definition,
        status: "inactive",
        mappingId: mapping.id,
        account: mapping.account,
        message: "Cuenta inactiva",
      };
    }

    return {
      ...definition,
      status: "configured",
      mappingId: mapping.id,
      account: mapping.account,
      message: "Configurado",
    };
  });
}

function buildPeriodReadiness(openPeriods: number, totalPeriods: number): PeriodReadiness {
  if (openPeriods > 0) {
    return {
      status: "available",
      openPeriods,
      totalPeriods,
      message: "Hay periodos contables disponibles.",
    };
  }

  if (totalPeriods > 0) {
    return {
      status: "review",
      openPeriods,
      totalPeriods,
      message: "No hay periodos abiertos para automatización futura.",
    };
  }

  return {
    status: "review",
    openPeriods,
    totalPeriods,
    message: "No hay periodos contables configurados; revisar antes de automatizar.",
  };
}

function getReadinessStatus(
  readinessItems: MappingReadinessItem[],
  invalidMappings: number,
  periodReadiness: PeriodReadiness,
): FinancialReadinessStatus {
  if (readinessItems.some((item) => item.status === "pending")) {
    return "incomplete";
  }

  if (readinessItems.some((item) => item.status === "inactive") || invalidMappings > 0 || periodReadiness.status === "review") {
    return "review";
  }

  return "ready";
}

export async function getFinancialCenterData(): Promise<FinancialCenterData> {
  const supabase = await getSupabaseServerClient();

  const [
    { data: mappingRows, error: mappingsError },
    { data: eventRows, error: eventsError },
    { data: automationSetting, error: settingError },
    { count: pendingEvents, error: pendingEventsError },
    { count: openPeriods, error: openPeriodsError },
    { count: totalPeriods, error: totalPeriodsError },
  ] = await Promise.all([
    supabase
      .from("accounting_mappings")
      .select(
        `
        id,
        mapping_type,
        source_key,
        account_id,
        priority,
        is_active,
        effective_from,
        effective_to,
        metadata,
        created_by,
        created_at,
        updated_at,
        accounting_accounts(id, code, name, type, is_active)
      `,
      )
      .order("mapping_type", { ascending: true })
      .order("source_key", { ascending: true })
      .order("priority", { ascending: true })
      .returns<AccountingMappingRow[]>(),
    supabase
      .from("financial_events")
      .select(
        "id, source_type, source_id, event_purpose, posting_version, status, occurred_at, source_snapshot, validation_errors, journal_entry_id, created_by, created_at, updated_at, journal_entries(id, entry_number, status)",
      )
      .order("occurred_at", { ascending: false })
      .limit(50)
      .returns<FinancialEventRow[]>(),
    supabase
      .from("accounting_automation_settings")
      .select("id, key, value, description, updated_by, created_at, updated_at")
      .eq("key", "automation_mode")
      .maybeSingle<AccountingAutomationSetting>(),
    supabase
      .from("financial_events")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("accounting_periods")
      .select("id", { count: "exact", head: true })
      .eq("status", "open"),
    supabase
      .from("accounting_periods")
      .select("id", { count: "exact", head: true }),
  ]);

  if (mappingsError) throw new Error(mappingsError.message);
  if (eventsError) throw new Error(eventsError.message);
  if (settingError) throw new Error(settingError.message);
  if (pendingEventsError) throw new Error(pendingEventsError.message);
  if (openPeriodsError) throw new Error(openPeriodsError.message);
  if (totalPeriodsError) throw new Error(totalPeriodsError.message);

  const mappings = (mappingRows ?? []).map(normalizeMapping);
  const events = (eventRows ?? []).map(normalizeFinancialEvent);
  const readinessItems = buildReadinessItems(mappings);
  const activeDefinitionCounts = new Map<string, number>();
  for (const mapping of mappings) {
    if (!mapping.is_active) continue;
    const key = `${mapping.mapping_type}:${mapping.source_key}:${mapping.priority}`;
    activeDefinitionCounts.set(key, (activeDefinitionCounts.get(key) ?? 0) + 1);
  }
  const duplicateActiveMappings = [...activeDefinitionCounts.values()].filter((count) => count > 1).length;
  const invalidMappings = mappings.filter((mapping) => mapping.is_active && (!mapping.account || !mapping.account.is_active)).length + duplicateActiveMappings;
  const periodReadiness = buildPeriodReadiness(openPeriods ?? 0, totalPeriods ?? 0);
  const readinessStatus = getReadinessStatus(readinessItems, invalidMappings, periodReadiness);
  const automationMode = normalizeAutomationMode(automationSetting ?? null);

  return {
    summary: {
      pendingEvents: pendingEvents ?? 0,
      configuredMappings: readinessItems.filter((item) => item.status === "configured").length,
      incompleteMappings: readinessItems.filter((item) => item.status !== "configured").length,
      invalidMappings,
      automationMode,
      readinessStatus,
    },
    mappings,
    events,
    readinessItems,
    automationSetting: automationSetting ?? null,
    periodReadiness,
  };
}
