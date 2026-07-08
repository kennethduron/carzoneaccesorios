import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  AccountingTraceabilityItem,
  AccountingTraceabilityStatus,
  AccountingTraceabilitySummary,
  AccountingTraceabilityTone,
} from "@/types/accounting-traceability";

type SourceType =
  | "order"
  | "payment"
  | "invoice"
  | "commercial_credit"
  | "accounts_receivable"
  | "receivable_payment"
  | "inventory_movement"
  | "purchase"
  | "supplier_invoice"
  | "accounts_payable"
  | "supplier_payment"
  | "purchase_return"
  | "supplier_credit";

type SourceReference = {
  sourceType: SourceType;
  sourceId: string | null | undefined;
};

type JournalEntryRow = {
  id: string;
  entry_number: string;
  entry_date: string;
  status: string;
  created_at: string;
  created_by: string | null;
  posted_at: string | null;
  posted_by: string | null;
};

type FinancialEventRow = {
  id: string;
  source_type: string;
  source_id: string;
  event_purpose: string;
  status: string;
  occurred_at: string;
  validation_errors: unknown;
  journal_entry_id: string | null;
  created_by: string | null;
  created_at: string;
  journal_entries: JournalEntryRow | JournalEntryRow[] | null;
};

type UserRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  roles: { name: string | null } | Array<{ name: string | null }> | null;
};

type PeriodRow = {
  name: string;
  start_date: string;
  end_date: string;
};

type TraceabilityBuildContext = {
  usersById: Map<string, UserRow>;
  periods: PeriodRow[];
};

type OrderTraceabilityInput = {
  orderId: string;
  paymentId?: string | null;
  invoiceId?: string | null;
  receivableId?: string | null;
};

type InvoiceTraceabilityInput = {
  invoiceId: string;
  orderId?: string | null;
  paymentId?: string | null;
};

export const accountingTraceabilityRoleLabels: Record<string, string> = {
  technical_owner: "Propietario tecnico",
  business_owner: "Dueno del negocio",
  admin: "Administrador",
  contadora: "Contadora",
  vendedor: "Vendedor",
  bodega: "Bodega",
  soporte: "Soporte",
  cliente: "Cliente",
};

export const accountingEventPurposeLabels: Record<string, string> = {
  sale_revenue: "Venta",
  payment_received: "Pago recibido",
  commercial_credit: "Credito comercial",
  commercial_credit_cancelled: "Credito comercial cancelado",
  receivable_payment: "Abono recibido",
  receivable_paid: "Cuenta por cobrar pagada",
  inventory_cogs: "Costo de ventas",
  inventory_return: "Devolucion de inventario",
  inventory_adjustment_gain: "Ajuste positivo de inventario",
  inventory_adjustment_loss: "Ajuste negativo de inventario",
  inventory_writeoff: "Inventario dado de baja",
  invoice_issued: "Factura emitida",
  invoice_cancelled: "Factura anulada",
  accounts_payable_created: "Cuenta por pagar",
  supplier_payment: "Pago a proveedor",
  supplier_payment_cancelled: "Pago a proveedor anulado",
  purchase_confirmed: "Compra confirmada",
  supplier_invoice_received: "Factura de proveedor",
  purchase_cancelled: "Compra anulada",
  purchase_return: "Devolucion a proveedor",
  supplier_credit: "Credito de proveedor",
  order_cancellation: "Anulacion de pedido",
};

export const accountingSourceTypeLabels: Record<string, string> = {
  order: "Pedido",
  payment: "Pago",
  invoice: "Factura",
  commercial_credit: "Credito comercial",
  accounts_receivable: "Cuenta por cobrar",
  receivable_payment: "Abono recibido",
  inventory_movement: "Inventario",
  purchase: "Compra",
  supplier_invoice: "Factura de proveedor",
  accounts_payable: "Cuenta por pagar",
  supplier_payment: "Pago a proveedor",
  purchase_return: "Devolucion a proveedor",
  supplier_credit: "Credito de proveedor",
  financial_event: "Evento financiero",
  manual: "Partida manual",
};

const controlOnlyPurposes = new Set([
  "invoice_issued",
  "invoice_cancelled",
  "receivable_paid",
  "commercial_credit_cancelled",
  "order_cancellation",
  "purchase_confirmed",
  "supplier_invoice_received",
  "purchase_cancelled",
  "supplier_payment_cancelled",
]);

const statusPriority: Record<AccountingTraceabilityStatus, number> = {
  published: 8,
  draft: 7,
  needs_configuration: 6,
  event: 5,
  control: 4,
  reversed: 3,
  cancelled: 2,
  other: 1,
  none: 0,
};

function first<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function formatDateTimeParts(value: string | null | undefined) {
  if (!value) {
    return { date: null, time: null };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { date: null, time: null };
  }

  return {
    date: new Intl.DateTimeFormat("es-HN", {
      timeZone: "America/Tegucigalpa",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(date),
    time: new Intl.DateTimeFormat("es-HN", {
      timeZone: "America/Tegucigalpa",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date),
  };
}

function roleName(user: UserRow | null | undefined) {
  const role = first(user?.roles);
  return role?.name ?? null;
}

function displayUser(user: UserRow | null | undefined, fallback: string) {
  return user?.full_name?.trim() || user?.email?.trim() || fallback;
}

function displayRole(user: UserRow | null | undefined) {
  const role = roleName(user);
  return role ? accountingTraceabilityRoleLabels[role] ?? role : null;
}

function validationErrors(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function hasMissingConfiguration(event: FinancialEventRow) {
  return validationErrors(event.validation_errors).some((issue) => {
    const normalized = issue.toLowerCase();
    return normalized.includes("mapeo") || normalized.includes("configur") || normalized.includes("cuenta no");
  });
}

function journalHref(entry: JournalEntryRow | null) {
  return entry ? `/admin/contabilidad#partida-${encodeURIComponent(entry.id)}` : null;
}

export function resolveAccountingOriginHref(sourceType: string, sourceId?: string | null) {
  if (!sourceId) return null;

  switch (sourceType) {
    case "order":
    case "payment":
      return "/admin/pedidos";
    case "invoice":
      return "/admin/facturas";
    case "commercial_credit":
    case "accounts_receivable":
    case "receivable_payment":
      return "/admin/cuentas-por-cobrar";
    case "purchase":
      return "/admin/compras";
    case "supplier_invoice":
    case "accounts_payable":
    case "supplier_payment":
    case "purchase_return":
    case "supplier_credit":
      return "/admin/cuentas-por-pagar";
    case "inventory_movement":
      return "/admin/inventario";
    default:
      return null;
  }
}

function resolvePeriod(periods: PeriodRow[], entryDate: string | null | undefined) {
  if (!entryDate) return null;
  return periods.find((period) => period.start_date <= entryDate && period.end_date >= entryDate)?.name ?? "Sin periodo asignado";
}

function resolveStatus(event: FinancialEventRow, journalEntry: JournalEntryRow | null): {
  status: AccountingTraceabilityStatus;
  statusLabel: string;
  tone: AccountingTraceabilityTone;
} {
  if (journalEntry?.status === "publicada") {
    return { status: "published", statusLabel: "Partida publicada", tone: "success" };
  }

  if (journalEntry?.status === "borrador") {
    return { status: "draft", statusLabel: "Partida en borrador", tone: "warning" };
  }

  if (journalEntry?.status === "reversada") {
    return { status: "reversed", statusLabel: "Partida reversada", tone: "neutral" };
  }

  if (journalEntry?.status === "anulada") {
    return { status: "cancelled", statusLabel: "Partida anulada", tone: "neutral" };
  }

  if (journalEntry) {
    return { status: "other", statusLabel: "Partida contable vinculada", tone: "info" };
  }

  if (hasMissingConfiguration(event)) {
    return { status: "needs_configuration", statusLabel: "Requiere configuracion contable", tone: "danger" };
  }

  if (controlOnlyPurposes.has(event.event_purpose) || event.status === "skipped") {
    return { status: "control", statusLabel: "Evento de control", tone: "neutral" };
  }

  return { status: "event", statusLabel: "Evento contable generado", tone: "info" };
}

function controlMessage(event: FinancialEventRow) {
  if (event.event_purpose === "invoice_issued" || event.event_purpose === "invoice_cancelled") {
    return "La factura fue registrada para control contable. La partida principal se genera desde la venta, pago o cuenta relacionada para evitar duplicidad.";
  }

  if (controlOnlyPurposes.has(event.event_purpose)) {
    return "Evento registrado para trazabilidad y control; no genera borrador contable para evitar duplicidad.";
  }

  return null;
}

function buildItem(event: FinancialEventRow, context: TraceabilityBuildContext): AccountingTraceabilityItem {
  const journalEntry = first(event.journal_entries);
  const status = resolveStatus(event, journalEntry);
  const generatedAt = journalEntry?.created_at ?? event.created_at;
  const generated = formatDateTimeParts(generatedAt);
  const published = journalEntry?.status === "publicada" ? formatDateTimeParts(journalEntry.posted_at) : { date: null, time: null };
  const generatedByUser = journalEntry?.created_by ? context.usersById.get(journalEntry.created_by) : event.created_by ? context.usersById.get(event.created_by) : null;
  const publishedByUser = journalEntry?.posted_by ? context.usersById.get(journalEntry.posted_by) : null;
  const generatedBy = journalEntry?.created_by || event.created_by
    ? displayUser(generatedByUser, "Usuario del sistema")
    : "Sistema";
  const publishedBy = journalEntry?.status === "publicada"
    ? displayUser(publishedByUser, "Usuario no identificado")
    : null;

  return {
    key: event.id,
    label: accountingEventPurposeLabels[event.event_purpose] ?? "Evento contable",
    status: status.status,
    statusLabel: status.statusLabel,
    tone: status.tone,
    message: status.status === "control" ? controlMessage(event) : null,
    entryNumber: journalEntry?.entry_number ?? null,
    generatedDate: generated.date,
    generatedTime: generated.time,
    generatedBy,
    generatedByRole: displayRole(generatedByUser),
    publishedDate: published.date,
    publishedTime: published.time,
    publishedBy,
    publishedByRole: displayRole(publishedByUser),
    accountingPeriod: journalEntry ? resolvePeriod(context.periods, journalEntry.entry_date) : null,
    journalEntryHref: journalHref(journalEntry),
    originLabel: accountingSourceTypeLabels[event.source_type] ?? null,
    originHref: resolveAccountingOriginHref(event.source_type, event.source_id),
  };
}

function emptySummary(originLabel = "Registro operativo"): AccountingTraceabilitySummary {
  return {
    items: [{
      key: "sin-evento",
      label: originLabel,
      status: "none",
      statusLabel: "Sin evento contable",
      tone: "neutral",
      message: null,
      entryNumber: null,
      generatedDate: null,
      generatedTime: null,
      generatedBy: "Sistema",
      generatedByRole: null,
      publishedDate: null,
      publishedTime: null,
      publishedBy: null,
      publishedByRole: null,
      accountingPeriod: null,
      journalEntryHref: null,
      originLabel,
      originHref: null,
    }],
    primaryStatus: "none",
    primaryStatusLabel: "Sin evento contable",
    primaryTone: "neutral",
  };
}

async function fetchEventsBySources(sources: SourceReference[]): Promise<FinancialEventRow[]> {
  const grouped = new Map<SourceType, string[]>();
  for (const source of sources) {
    if (!source.sourceId) continue;
    const current = grouped.get(source.sourceType) ?? [];
    current.push(source.sourceId);
    grouped.set(source.sourceType, current);
  }

  if (grouped.size === 0) return [];

  const supabase = await getSupabaseServerClient();
  const results = await Promise.all([...grouped.entries()].map(async ([sourceType, sourceIds]) => {
    const uniqueIds = [...new Set(sourceIds)];
    const { data, error } = await supabase
      .from("financial_events")
      .select(
        "id, source_type, source_id, event_purpose, status, occurred_at, validation_errors, journal_entry_id, created_by, created_at, journal_entries(id, entry_number, entry_date, status, created_at, created_by, posted_at, posted_by)",
      )
      .eq("source_type", sourceType)
      .in("source_id", uniqueIds)
      .order("occurred_at", { ascending: true })
      .returns<FinancialEventRow[]>();

    if (error) throw new Error(error.message);
    return data ?? [];
  }));

  return results.flat();
}

async function buildContext(events: FinancialEventRow[]): Promise<TraceabilityBuildContext> {
  const supabase = await getSupabaseServerClient();
  const userIds = new Set<string>();
  const entryDates = new Set<string>();

  for (const event of events) {
    if (event.created_by) userIds.add(event.created_by);
    const journalEntry = first(event.journal_entries);
    if (journalEntry?.created_by) userIds.add(journalEntry.created_by);
    if (journalEntry?.posted_by) userIds.add(journalEntry.posted_by);
    if (journalEntry?.entry_date) entryDates.add(journalEntry.entry_date);
  }

  const [usersResult, periodsResult] = await Promise.all([
    userIds.size > 0
      ? supabase
          .from("users")
          .select("id, full_name, email, roles(name)")
          .in("id", [...userIds])
          .returns<UserRow[]>()
      : Promise.resolve({ data: [], error: null }),
    entryDates.size > 0
      ? supabase
          .from("accounting_periods")
          .select("name, start_date, end_date")
          .order("start_date", { ascending: false })
          .returns<PeriodRow[]>()
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (usersResult.error) throw new Error(usersResult.error.message);
  if (periodsResult.error) throw new Error(periodsResult.error.message);

  return {
    usersById: new Map((usersResult.data ?? []).map((user) => [user.id, user])),
    periods: periodsResult.data ?? [],
  };
}

async function buildSummary(events: FinancialEventRow[], originLabel: string): Promise<AccountingTraceabilitySummary> {
  if (events.length === 0) {
    return emptySummary(originLabel);
  }

  const context = await buildContext(events);
  const items = events.map((event) => buildItem(event, context));
  const primary = items.reduce((best, item) => (statusPriority[item.status] > statusPriority[best.status] ? item : best), items[0]);

  return {
    items,
    primaryStatus: primary.status,
    primaryStatusLabel: primary.statusLabel,
    primaryTone: primary.tone,
  };
}

function sourcesForOrder(input: OrderTraceabilityInput): SourceReference[] {
  return [
    { sourceType: "order", sourceId: input.orderId },
    { sourceType: "payment", sourceId: input.paymentId },
    { sourceType: "invoice", sourceId: input.invoiceId },
    { sourceType: "commercial_credit", sourceId: input.receivableId },
    { sourceType: "accounts_receivable", sourceId: input.receivableId },
  ];
}

function sourcesForInvoice(input: InvoiceTraceabilityInput): SourceReference[] {
  return [
    { sourceType: "invoice", sourceId: input.invoiceId },
    { sourceType: "order", sourceId: input.orderId },
    { sourceType: "payment", sourceId: input.paymentId },
  ];
}

function eventMatchesSources(event: FinancialEventRow, sources: SourceReference[]) {
  return sources.some((source) => source.sourceId === event.source_id && source.sourceType === event.source_type);
}

export async function getInvoiceAccountingTraceability(input: InvoiceTraceabilityInput): Promise<AccountingTraceabilitySummary> {
  const sources = sourcesForInvoice(input);
  const events = await fetchEventsBySources(sources);
  return buildSummary(events, "Factura");
}

export async function getOrderAccountingTraceabilityBatch(inputs: OrderTraceabilityInput[]): Promise<Map<string, AccountingTraceabilitySummary>> {
  const allSources = inputs.flatMap(sourcesForOrder);
  const events = await fetchEventsBySources(allSources);
  const context = events.length > 0 ? await buildContext(events) : null;
  const result = new Map<string, AccountingTraceabilitySummary>();

  for (const input of inputs) {
    const sources = sourcesForOrder(input);
    const matchingEvents = events.filter((event) => eventMatchesSources(event, sources));
    if (matchingEvents.length === 0 || !context) {
      result.set(input.orderId, emptySummary("Pedido"));
      continue;
    }

    const items = matchingEvents.map((event) => buildItem(event, context));
    const primary = items.reduce((best, item) => (statusPriority[item.status] > statusPriority[best.status] ? item : best), items[0]);
    result.set(input.orderId, {
      items,
      primaryStatus: primary.status,
      primaryStatusLabel: primary.statusLabel,
      primaryTone: primary.tone,
    });
  }

  return result;
}
