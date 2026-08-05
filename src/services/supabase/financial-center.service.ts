import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  AccountingAutomationSetting,
  AccountingFeatureFlag,
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

type AccountingOutboxRow = NonNullable<FinancialEvent["outbox"]> & {
  source_id: string;
};

type AccountingOutboxV2Row = {
  id: string;
  source_id: string;
  financial_event_id: string | null;
  feature_key: string;
  topic: string;
  scenario: string;
  posting_version: string;
  status: NonNullable<FinancialEvent["outbox"]>["status"];
  attempt_count: number;
  next_attempt_at: string;
  last_error_message: string | null;
  missing_key: string | null;
  duplicate_avoided: boolean;
  compensated_event_id: string | null;
  cutover_at: string;
  processed_at: string | null;
};

const automationModes = new Set<AutomationMode>(["disabled", "dry_run", "draft_only", "auto_post"]);

export const requiredAccountingMappings: RequiredMappingDefinition[] = [
  { key: "cash", label: "Caja", mappingType: "payment_method", sourceKey: "cash" },
  { key: "bank_transfer", label: "Banco / transferencia", mappingType: "payment_method", sourceKey: "bank_transfer" },
  { key: "card", label: "Cuenta puente de tarjeta", mappingType: "payment_method", sourceKey: "card" },
  { key: "accounts_receivable", label: "Cuenta por cobrar", mappingType: "receivable", sourceKey: "accounts_receivable" },
  { key: "sales_revenue", label: "Ingresos por ventas", mappingType: "revenue", sourceKey: "sales_revenue" },
  { key: "sale_shipping_fee", label: "Ingreso por entrega", mappingType: "revenue", sourceKey: "sale_shipping_fee" },
  { key: "sale_cod_fee", label: "Ingreso por contraentrega", mappingType: "revenue", sourceKey: "sale_cod_fee" },
  { key: "sale_external_charge", label: "Cargo externo de entrega", mappingType: "revenue", sourceKey: "sale_external_charge" },
  { key: "sale_other_charge", label: "Otros cargos de venta", mappingType: "revenue", sourceKey: "sale_other_charge" },
  { key: "tax_payable", label: "Impuestos por pagar", mappingType: "tax", sourceKey: "tax_payable" },
  { key: "inventory_asset", label: "Inventario", mappingType: "inventory", sourceKey: "inventory_asset" },
  { key: "cost_of_goods_sold", label: "Costo de ventas", mappingType: "inventory", sourceKey: "cost_of_goods_sold" },
  { key: "inventory_return", label: "Devolución de inventario", mappingType: "inventory", sourceKey: "inventory_return" },
  { key: "inventory_adjustment_gain", label: "Ajuste positivo de inventario", mappingType: "inventory", sourceKey: "inventory_adjustment_gain" },
  { key: "inventory_adjustment_loss", label: "Ajuste negativo de inventario", mappingType: "inventory", sourceKey: "inventory_adjustment_loss" },
  { key: "inventory_writeoff", label: "Inventario dado de baja", mappingType: "inventory", sourceKey: "inventory_writeoff" },
  { key: "accounts_payable", label: "Proveedores por pagar", mappingType: "default_account", sourceKey: "accounts_payable" },
  { key: "purchase_inventory", label: "Inventario para compras", mappingType: "inventory", sourceKey: "purchase_inventory" },
  { key: "purchase_expense", label: "Gasto de compras", mappingType: "default_account", sourceKey: "purchase_expense" },
  { key: "supplier_payment_cash", label: "Pago a proveedores - caja", mappingType: "payment_method", sourceKey: "supplier_payment_cash" },
  { key: "supplier_payment_bank", label: "Pago a proveedores - banco", mappingType: "payment_method", sourceKey: "supplier_payment_bank" },
  { key: "supplier_payment_card", label: "Pago a proveedores - tarjeta de crédito", mappingType: "payment_method", sourceKey: "supplier_payment_card" },
  { key: "purchase_tax", label: "Impuesto de compras", mappingType: "tax", sourceKey: "purchase_tax" },
  { key: "purchase_return", label: "Devoluciones de compras", mappingType: "default_account", sourceKey: "purchase_return" },
  { key: "supplier_credit", label: "Crédito de proveedor", mappingType: "default_account", sourceKey: "supplier_credit" },
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

export async function getFinancialCenterData(input: {
  eventPage?: number;
  eventPageSize?: number;
  eventSearch?: string;
  eventStatus?: string;
  eventPurpose?: string;
} = {}): Promise<FinancialCenterData> {
  const supabase = await getSupabaseServerClient();
  const eventPageSize = Math.min(Math.max(Math.trunc(input.eventPageSize ?? 25), 10), 100);
  const eventPage = Math.max(Math.trunc(input.eventPage ?? 1), 1);
  const eventSearch = (input.eventSearch ?? "").trim().slice(0, 80).replace(/[%_,()]/g, "");
  const eventStatus = (input.eventStatus ?? "").trim();
  const eventPurpose = (input.eventPurpose ?? "").trim();
  let eventsQuery = supabase
    .from("financial_events")
    .select(
      "id, source_type, source_id, event_purpose, posting_version, status, occurred_at, accounting_date, source_snapshot, validation_errors, journal_entry_id, created_by, created_at, updated_at, journal_entries(id, entry_number, status)",
      { count: "exact" },
    );

  if (eventStatus) eventsQuery = eventsQuery.eq("status", eventStatus);
  if (eventPurpose) eventsQuery = eventsQuery.eq("event_purpose", eventPurpose);
  if (eventSearch) {
    const pattern = `%${eventSearch}%`;
    eventsQuery = eventsQuery.or(
      `source_id.ilike.${pattern},source_snapshot->>receivable_id.ilike.${pattern},source_snapshot->>customer_name.ilike.${pattern}`,
    );
  }
  eventsQuery = eventsQuery
    .order("occurred_at", { ascending: false })
    .range((eventPage - 1) * eventPageSize, eventPage * eventPageSize - 1);

  const [
    { data: mappingRows, error: mappingsError },
    { data: eventRows, error: eventsError, count: eventCount },
    { data: automationSetting, error: settingError },
    { data: featureFlagRows, error: featureFlagsError },
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
    eventsQuery.returns<FinancialEventRow[]>(),
    supabase
      .from("accounting_automation_settings")
      .select("id, key, value, description, updated_by, created_at, updated_at")
      .eq("key", "automation_mode")
      .maybeSingle<AccountingAutomationSetting>(),
    supabase
      .from("accounting_feature_flags")
      .select("key, state, cutover_at, version, updated_by, notes, created_at, updated_at")
      .order("key")
      .returns<AccountingFeatureFlag[]>(),
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
  if (featureFlagsError) throw new Error(featureFlagsError.message);
  if (pendingEventsError) throw new Error(pendingEventsError.message);
  if (openPeriodsError) throw new Error(openPeriodsError.message);
  if (totalPeriodsError) throw new Error(totalPeriodsError.message);

  const mappings = (mappingRows ?? []).map(normalizeMapping);
  const normalizedEvents = (eventRows ?? []).map(normalizeFinancialEvent);
  const receivablePaymentIds = normalizedEvents
    .filter((event) => event.source_type === "receivable_payment" && event.event_purpose === "receivable_payment")
    .map((event) => event.source_id);
  const { data: outboxRows, error: outboxError } = receivablePaymentIds.length > 0
    ? await supabase
        .from("accounting_outbox")
        .select("id, source_id, status, attempts, last_error, available_at, processed_at")
        .eq("source_type", "receivable_payment")
        .eq("event_purpose", "receivable_payment")
        .eq("posting_version", "v1")
        .in("source_id", receivablePaymentIds)
        .returns<AccountingOutboxRow[]>()
    : { data: [], error: null };
  if (outboxError) throw new Error(outboxError.message);
  const outboxByPayment = new Map((outboxRows ?? []).map((row) => [row.source_id, row]));
  const eventIds = normalizedEvents.map((event) => event.id);
  const { data: outboxV2Rows, error: outboxV2Error } = eventIds.length > 0
    ? await supabase
        .from("accounting_outbox_v2")
        .select("id, source_id, financial_event_id, feature_key, topic, scenario, posting_version, status, attempt_count, next_attempt_at, last_error_message, missing_key, duplicate_avoided, compensated_event_id, cutover_at, processed_at")
        .in("financial_event_id", eventIds)
        .returns<AccountingOutboxV2Row[]>()
    : { data: [], error: null };
  if (outboxV2Error) throw new Error(outboxV2Error.message);
  const outboxV2ByEvent = new Map((outboxV2Rows ?? []).map((row) => [row.financial_event_id, row]));
  const events = normalizedEvents.map((event) => ({
    ...event,
    outbox: outboxV2ByEvent.has(event.id)
      ? (() => {
          const row = outboxV2ByEvent.get(event.id)!;
          return {
            id: row.id,
            status: row.status,
            attempts: row.attempt_count,
            last_error: row.last_error_message,
            available_at: row.next_attempt_at,
            processed_at: row.processed_at,
            module: row.feature_key,
            topic: row.topic,
            scenario: row.scenario,
            next_attempt_at: row.next_attempt_at,
            cutover_at: row.cutover_at,
            posting_version: row.posting_version,
            missing_key: row.missing_key,
            duplicate_avoided: row.duplicate_avoided,
            compensated_event_id: row.compensated_event_id,
          };
        })()
      : event.source_type === "receivable_payment"
        ? outboxByPayment.get(event.source_id) ?? null
        : null,
  }));
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
    featureFlags: featureFlagRows ?? [],
    periodReadiness,
    eventQuery: {
      search: eventSearch,
      status: eventStatus,
      purpose: eventPurpose,
    },
    eventPagination: {
      page: eventPage,
      pageSize: eventPageSize,
      total: eventCount ?? 0,
      totalPages: Math.max(Math.ceil((eventCount ?? 0) / eventPageSize), 1),
    },
  };
}
