"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Activity, AlertTriangle, BookOpen, CheckCircle2, Clock, ExternalLink, FilePlus2, Landmark, LayoutDashboard, RefreshCw, Save, SearchCheck, Settings2, SlidersHorizontal, ToggleLeft, ToggleRight } from "lucide-react";
import {
  generateJournalDraftFromFinancialEventAction,
  retryAccountingOutboxV2Action,
  retryReceivablePaymentAccountingAction,
  saveAccountingMappingAction,
  scanFinancialEventsAction,
  toggleAccountingMappingAction,
  updateAutomationModeAction,
} from "@/app/admin/contabilidad/actions";
import { AccountingManager } from "@/components/admin/accounting-manager";
import { AccountingAccountCombobox } from "@/components/admin/accounting-account-combobox";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { buildJournalEntryViewerHref, normalizeFinancialCenterTab, type FinancialCenterTab } from "@/lib/accounting-navigation";
import {
  accountingAutomationModeLabels,
  phase2AAutomationModes,
  accountingMappingTypeLabels,
  getAccountingMappingDisplayLabel,
} from "@/services/supabase/accounting-config.service";
import type { AccountingPageData, JournalEntryViewerData, JournalEntryViewerStatus } from "@/types/accounting";
import type { AccountingAccountSearchResult } from "@/types/admin-search";
import type {
  AccountingMapping,
  AutomationMode,
  FinancialCenterData,
  FinancialEvent,
  FinancialEventStatus,
  FinancialReadinessStatus,
  MappingReadinessStatus,
} from "@/types/financial-center";
import { formatHnDateTime } from "@/utils/format";

type FinancialCenterManagerProps = {
  accountingData: AccountingPageData;
  financialData: FinancialCenterData;
  initialTab: FinancialCenterTab;
  focusedEntryData: JournalEntryViewerData | null;
  focusedEntryId: string | null;
  focusedEntryStatus: JournalEntryViewerStatus;
  canManage: boolean;
  canCreate: boolean;
  canEditDrafts: boolean;
  canPost: boolean;
  canReverse: boolean;
  canConfigureAccounting: boolean;
  canExportAccounting: boolean;
  canExportTechnicalCsv: boolean;
  canScanEvents: boolean;
  canGenerateDrafts: boolean;
  canRetryPaymentEvents: boolean;
};

const tabs: Array<{ key: FinancialCenterTab; label: string; icon: typeof LayoutDashboard }> = [
  { key: "summary", label: "Resumen financiero", icon: LayoutDashboard },
  { key: "mappings", label: "Configuración contable", icon: Settings2 },
  { key: "events", label: "Eventos financieros", icon: Activity },
  { key: "journal", label: "Libro diario", icon: BookOpen },
  { key: "accounts", label: "Catálogo de cuentas", icon: Landmark },
];

const readinessLabels: Record<FinancialReadinessStatus, string> = {
  ready: "Listo para automatizar",
  incomplete: "Configuración incompleta",
  review: "Requiere revisión",
};

const readinessClasses: Record<FinancialReadinessStatus, string> = {
  ready: "border-[#2f6f3e]/20 bg-[#edf7ed] text-[#2f6f3e]",
  incomplete: "border-[#e4252c]/20 bg-[#fff1f2] text-[#b91c25]",
  review: "border-[#f59e0b]/25 bg-[#fff7ed] text-[#7c2d12]",
};

const mappingStatusLabels: Record<MappingReadinessStatus, string> = {
  configured: "Configurado",
  pending: "Pendiente",
  inactive: "Cuenta inactiva",
};

const eventStatusLabels: Record<FinancialEventStatus, string> = {
  pending: "Pendiente",
  ready: "Listo",
  draft_created: "Borrador creado",
  posted: "Publicado",
  failed: "Error",
  skipped: "Omitido",
  reversed: "Reversado",
};

const inventoryEventPurposes = new Set(["inventory_cogs", "inventory_return", "inventory_adjustment_gain", "inventory_adjustment_loss", "inventory_writeoff"]);
const purchaseApEventPurposes = new Set(["purchase_confirmed", "supplier_invoice_received", "accounts_payable_created", "supplier_payment", "supplier_payment_cancelled", "purchase_cancelled", "purchase_return", "supplier_credit"]);

const draftEligiblePurposes = new Set([
  "sale_revenue",
  "payment_received",
  "commercial_credit",
  "receivable_payment",
  "inventory_cogs",
  "inventory_return",
  "inventory_adjustment_gain",
  "inventory_adjustment_loss",
  "inventory_writeoff",
  "accounts_payable_created",
  "supplier_payment",
  "purchase_return",
  "supplier_credit",
]);

const draftEligibleStatuses = new Set<FinancialEventStatus>(["pending", "ready", "failed"]);

const eventPurposeLabels: Record<string, string> = {
  sale_recognized: "Venta reconocida V2",
  sale_revenue: "Venta confirmada",
  payment_received: "Pago recibido",
  invoice_issued: "Factura fiscal emitida",
  invoice_cancelled: "Factura fiscal anulada",
  commercial_credit: "Crédito comercial creado",
  commercial_credit_cancelled: "Crédito comercial cancelado",
  receivable_payment: "Abono recibido",
  receivable_paid: "Cuenta por cobrar pagada",
  order_cancellation: "Cancelación de pedido",
  inventory_cogs: "Costo de ventas",
  inventory_return: "Devolución de inventario",
  inventory_adjustment_gain: "Ajuste positivo de inventario",
  inventory_adjustment_loss: "Ajuste negativo de inventario",
  inventory_writeoff: "Inventario dado de baja",
  purchase_confirmed: "Compra confirmada",
  supplier_invoice_received: "Factura de proveedor recibida",
  accounts_payable_created: "Cuenta por pagar creada",
  supplier_payment: "Pago a proveedor",
  supplier_payment_cancelled: "Pago a proveedor anulado",
  sale_compensation: "Compensación de venta V2",
  inventory_cogs_compensation: "Compensación de costo V2",
  supplier_payment_compensation: "Compensación de pago V2",
  purchase_cancelled: "Compra anulada",
  purchase_return: "Devolución a proveedor",
  supplier_credit: "Nota de crédito de proveedor",
};

const sourceTypeLabels: Record<string, string> = {
  order: "Pedido",
  payment: "Pago",
  invoice: "Factura fiscal",
  commercial_credit: "Crédito comercial",
  accounts_receivable: "Cuenta por cobrar",
  receivable_payment: "Abono",
  inventory_movement: "Movimiento de inventario",
  purchase: "Compra",
  supplier_invoice: "Factura de proveedor",
  accounts_payable: "Cuenta por pagar",
  supplier_payment: "Pago a proveedor",
  purchase_return: "Devolución a proveedor",
  supplier_credit: "Nota de crédito de proveedor",
};

const inventoryMovementTypeLabels: Record<string, string> = {
  sale: "Venta",
  return: "Devolución",
  adjustment: "Ajuste",
  writeoff: "Merma de inventario",
};
function formatNumber(value: number) {
  return value.toLocaleString("es-HN");
}

function formatCurrency(value: unknown) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return "-";

  return new Intl.NumberFormat("es-HN", {
    style: "currency",
    currency: "HNL",
    minimumFractionDigits: 2,
  }).format(amount);
}

function snapshotText(snapshot: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = snapshot[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }

  return null;
}

function shortReference(value: string | null) {
  if (!value) return null;
  return /^[0-9a-f-]{32,36}$/i.test(value) ? `${value.slice(0, 8)}…` : value;
}

function validationMessages(value: unknown[]) {
  return value.map((item) => String(item)).filter(Boolean);
}

function eventAmount(event: FinancialEvent) {
  return event.source_snapshot.total_cost_snapshot ?? event.source_snapshot.amount ?? event.source_snapshot.total ?? event.source_snapshot.total_amount ?? event.source_snapshot.original_amount;
}

function eventDetail(event: FinancialEvent) {
  if (event.source_type === "accounts_receivable" && event.event_purpose === "receivable_paid") {
    return {
      title: "Evento de control",
      helper: "El movimiento contable se registra mediante cada abono recibido.",
    };
  }

  if (event.source_type === "receivable_payment" && event.event_purpose === "receivable_payment") {
    const customer = snapshotText(event.source_snapshot, ["customer_name"]) ?? "Cliente";
    const method = snapshotText(event.source_snapshot, ["payment_method"]) ?? "sin método";
    const receivableId = snapshotText(event.source_snapshot, ["receivable_id"]);
    return {
      title: customer,
      helper: [`Método ${method}`, receivableId ? `CxC ${shortReference(receivableId)}` : null]
        .filter(Boolean)
        .join(" · "),
    };
  }

  if (inventoryEventPurposes.has(event.event_purpose)) {
    const product = snapshotText(event.source_snapshot, ["product_name", "sku"]) ?? "Producto no identificado";
    const sku = snapshotText(event.source_snapshot, ["sku"]);
    const quantity = event.source_snapshot.quantity;
    const movementType = snapshotText(event.source_snapshot, ["movement_type"]);
    const movementLabel = movementType ? inventoryMovementTypeLabels[movementType] ?? movementType : null;
    const unitCost = event.source_snapshot.unit_cost_snapshot;
    const totalCost = event.source_snapshot.total_cost_snapshot;
    return {
      title: product,
      helper: [
        sku ? `SKU ${sku}` : null,
        quantity != null ? `Cantidad ${quantity}` : null,
        unitCost != null ? `Costo unitario ${formatCurrency(unitCost)}` : null,
        totalCost != null ? `Costo ${formatCurrency(totalCost)}` : null,
        movementLabel ? `Movimiento ${movementLabel}` : null,
      ].filter(Boolean).join(" · "),
    };
  }

  if (purchaseApEventPurposes.has(event.event_purpose)) {
    const supplier = snapshotText(event.source_snapshot, ["supplier_name"]) ?? "Proveedor no identificado";
    const documentNumber = snapshotText(event.source_snapshot, ["purchase_number", "invoice_number", "return_number", "credit_number", "supplier_payment_id", "accounts_payable_id"]);
    const paymentMethod = snapshotText(event.source_snapshot, ["payment_method"]);
    const status = snapshotText(event.source_snapshot, ["status"]);
    const date = snapshotText(event.source_snapshot, ["purchase_date", "invoice_date", "return_date", "credit_date", "due_date", "paid_at"]);
    const total = event.source_snapshot.total ?? event.source_snapshot.total_amount ?? event.source_snapshot.amount;
    const amount = event.source_snapshot.amount;
    const balance = event.source_snapshot.balance;
    return {
      title: supplier,
      helper: [
        documentNumber ? `Documento ${shortReference(documentNumber)}` : null,
        paymentMethod ? `M\u00e9todo ${paymentMethod}` : null,
        amount != null ? `Monto ${formatCurrency(amount)}` : null,
        total != null ? `Total ${formatCurrency(total)}` : null,
        balance != null ? `Saldo ${formatCurrency(balance)}` : null,
        status ? `Estado ${status}` : null,
        date ? `Fecha ${String(date).slice(0, 10)}` : null,
      ].filter(Boolean).join(" · "),
    };
  }

  return {
    title: snapshotText(event.source_snapshot, ["customer_name", "customer", "client_name"]) ?? "-",
    helper: "",
  };
}

function resolveAccountingOriginHref(sourceType: string, sourceId?: string | null) {
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

function eventStatusText(event: FinancialEvent) {
  if (event.event_purpose === "receivable_paid" && event.status === "skipped") {
    return "Omitido (control)";
  }

  if (event.status === "skipped" && event.validation_errors.includes("SUPERSEDED_BY_CANONICAL_V2_EVENT")) {
    return "Omitido (cubierto por V2)";
  }

  if (inventoryEventPurposes.has(event.event_purpose)) {
    if (event.status === "pending") return "Movimiento pendiente";
    if (event.status === "ready") return "Movimiento listo";
  }

  return eventStatusLabels[event.status];
}

function validationIssueLabel(issue: string) {
  if (issue.includes("costo histórico") || issue.includes("costo histórico")) return "Costo histórico faltante";
  if (issue.includes("ajustes de inventario")) return "Mapeo de ajuste incompleto";
  if (issue.includes("mapeos contables para inventario")) return "Mapeo de inventario incompleto";
  if (issue.includes("proveedores por pagar")) return "Mapeo de proveedores incompleto";
  if (issue.includes("pagos a proveedores")) return "Mapeo de pago a proveedor incompleto";
  if (issue.includes("mapeos de compras")) return "Mapeo de compras incompleto";
  if (issue.includes("costo del producto")) return "Costo del producto faltante";
  if (issue.includes("Merma") || issue.includes("merma")) return "Merma de inventario";
  return null;
}

function pendingConceptMessage(missingKey: string | null | undefined) {
  if (missingKey === "revenue:sale_cod_fee") {
    return "Cuenta contable pendiente: Ventas por contraentrega. Falta configurar la cuenta autorizada.";
  }
  if (missingKey) return "Falta configurar una cuenta contable requerida para este documento.";
  return null;
}

function formatAccountingDate(value: string | null | undefined) {
  const parts = value?.split("-");
  if (!parts || parts.length !== 3) return null;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function canGenerateDraftForEvent(event: FinancialEvent) {
  return event.posting_version !== "v2"
    && !event.journal_entry_id
    && draftEligiblePurposes.has(event.event_purpose)
    && draftEligibleStatuses.has(event.status);
}

export function FinancialCenterManager({
  accountingData,
  financialData,
  initialTab,
  focusedEntryData,
  focusedEntryId,
  focusedEntryStatus,
  canManage,
  canCreate,
  canEditDrafts,
  canPost,
  canReverse,
  canConfigureAccounting,
  canExportAccounting,
  canExportTechnicalCsv,
  canScanEvents,
  canGenerateDrafts,
  canRetryPaymentEvents,
}: FinancialCenterManagerProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [fallbackTab, setFallbackTab] = useState<FinancialCenterTab>(initialTab);
  const [eventFilter, setEventFilter] = useState<"all" | "pending" | "sales_v2" | "cogs_v2" | "supplier_v2" | "drafts">("all");
  const [outboxStatusFilter, setOutboxStatusFilter] = useState<
    "all" | NonNullable<FinancialEvent["outbox"]>["status"]
  >("all");
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(financialData.readinessItems.map((item) => [item.key, item.account?.id ?? ""])),
  );
  const [selectedAccountOptions, setSelectedAccountOptions] = useState<Record<string, AccountingAccountSearchResult | null>>(() =>
    Object.fromEntries(financialData.readinessItems.map((item) => [item.key, item.account ? {
      id: item.account.id,
      code: item.account.code,
      name: item.account.name,
      accountType: item.account.type,
      normalBalance: ["asset", "cost", "expense"].includes(item.account.type) ? "debit" : "credit",
      isActive: item.account.is_active,
      parentId: null,
      isSelectable: item.account.is_active,
    } : null])),
  );
  const [automationMode, setAutomationMode] = useState<AutomationMode>(financialData.summary.automationMode);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  const selectedEntryId = searchParams.get("partida");
  const hasFocusedRequest = Boolean(selectedEntryId && selectedEntryId === focusedEntryId);
  const activeTab = selectedEntryId
    ? "journal"
    : searchParams.has("tab")
      ? normalizeFinancialCenterTab(searchParams.get("tab"))
      : fallbackTab;

  function updateUrl(mutator: (params: URLSearchParams) => void) {
    const nextParams = new URLSearchParams(searchParams.toString());
    mutator(nextParams);
    const query = nextParams.toString();
    window.history.pushState(null, "", query ? `${pathname}?${query}` : pathname);
  }

  function selectTab(tab: FinancialCenterTab) {
    setFallbackTab(tab);
    updateUrl((params) => {
      params.set("tab", tab);
      if (tab !== "journal") params.delete("partida");
    });
  }

  function closeFocusedEntry() {
    setFallbackTab("journal");
    updateUrl((params) => {
      params.set("tab", "journal");
      params.delete("partida");
    });
  }

  const configuredLabel = `${formatNumber(financialData.summary.configuredMappings)} de ${formatNumber(financialData.readinessItems.length)}`;
  const visibleEvents = financialData.events.filter((event) => {
    if (outboxStatusFilter !== "all" && event.outbox?.status !== outboxStatusFilter) return false;
    if (eventFilter === "pending") return ["pending", "failed"].includes(event.status) || ["pending_mapping", "pending_data", "failed"].includes(event.outbox?.status ?? "");
    if (eventFilter === "sales_v2") return event.event_purpose === "sale_recognized" && event.posting_version === "v2";
    if (eventFilter === "cogs_v2") return event.event_purpose === "inventory_cogs" && event.posting_version === "v2";
    if (eventFilter === "supplier_v2") return event.event_purpose === "supplier_payment" && event.posting_version === "v2";
    if (eventFilter === "drafts") return event.status === "draft_created";
    return true;
  });
  const hasEvents = visibleEvents.length > 0;

  const mappingsByRequiredKey = useMemo(() => {
    return new Map(financialData.readinessItems.map((item) => [item.key, item]));
  }, [financialData.readinessItems]);

  function saveMapping(requiredKey: string) {
    const item = mappingsByRequiredKey.get(requiredKey);
    const accountId = selectedAccounts[requiredKey] ?? "";
    if (!item || !accountId) {
      toast.error("Selecciona una cuenta contable.");
      return;
    }

    startTransition(async () => {
      const result = await saveAccountingMappingAction({
        id: item.mappingId ?? undefined,
        mapping_type: item.mappingType,
        source_key: item.sourceKey,
        account_id: accountId,
        priority: 100,
        is_active: true,
      });
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function toggleMapping(mapping: AccountingMapping) {
    startTransition(async () => {
      const result = await toggleAccountingMappingAction(mapping.id, !mapping.is_active);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function saveAutomationMode() {
    startTransition(async () => {
      const result = await updateAutomationModeAction(automationMode);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function scanFinancialEvents() {
    startTransition(async () => {
      const result = await scanFinancialEventsAction();
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function reviewPendingEvents() {
    selectTab("events");
    setEventFilter("pending");
  }

  function generateDraft(eventId: string) {
    startTransition(async () => {
      const result = await generateJournalDraftFromFinancialEventAction(eventId);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function retryPaymentEvent(outboxId: string) {
    startTransition(async () => {
      const result = await retryReceivablePaymentAccountingAction(outboxId);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  function retryV2Event(outboxId: string) {
    startTransition(async () => {
      const result = await retryAccountingOutboxV2Action(outboxId);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  function eventPageHref(page: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "events");
    params.set("event_page", String(page));
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="min-w-0 space-y-5">
      <nav className="flex w-full max-w-full min-w-0 gap-2 overflow-x-auto rounded-lg border border-black/10 bg-white p-2 shadow-sm" aria-label="Secciones de contabilidad">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => selectTab(tab.key)}
              className={`inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                active ? "bg-[#080808] text-white" : "text-black/65 hover:bg-[#fff1f2] hover:text-[#b91c25]"
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </nav>

      {activeTab === "summary" ? (
        <section className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard label="Eventos pendientes" value={formatNumber(financialData.summary.pendingEvents)} helper="Registro financiero" />
            <SummaryCard label="Mapeos configurados" value={configuredLabel} helper="Base de automatización" />
            <SummaryCard label="Configuración incompleta" value={formatNumber(financialData.summary.incompleteMappings)} helper="Mapeos requeridos" />
            <SummaryCard label="Modo de automatización" value={accountingAutomationModeLabels[financialData.summary.automationMode]} helper="Publicación automática deshabilitada" />
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm sm:p-5">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <SlidersHorizontal size={19} />
                    <h2 className="text-lg font-semibold">Estado de configuración</h2>
                  </div>
                  <p className="mt-1 text-sm text-black/55">Mapeos requeridos antes de activar automatización futura.</p>
                </div>
                <StatusPill status={financialData.summary.readinessStatus} />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {financialData.readinessItems.map((item) => (
                  <article key={item.key} className="rounded-md border border-black/10 bg-[#fafafa] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold">{item.label}</p>
                        <p className="mt-1 text-sm text-black/55">
                          {accountingMappingTypeLabels[item.mappingType]} · {getAccountingMappingDisplayLabel(item.sourceKey)}
                        </p>
                        <p className="mt-1 text-xs text-black/45">
                          {item.account ? `${item.account.code} - ${item.account.name}` : "Cuenta no configurada"}
                        </p>
                      </div>
                      <MappingStatusBadge status={item.status} />
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <aside className="rounded-lg border border-black/10 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2">
                {financialData.summary.readinessStatus === "ready" ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}
                <h2 className="text-lg font-semibold">Estado de automatización</h2>
              </div>
              <p className="mt-3 text-sm leading-6 text-black/60">{readinessLabels[financialData.summary.readinessStatus]}</p>
              <div className="mt-4 space-y-3 text-sm text-black/60">
                <p className="rounded-md border border-black/10 bg-[#fafafa] p-3">{financialData.periodReadiness.message}</p>
                <p className="rounded-md border border-[#e4252c]/15 bg-[#fff1f2] p-3 text-[#7f1d1d]">
                  El modo global sigue desactivado. Los módulos V2 usan flags separados, fecha de corte prospectiva y publicación siempre manual.
                </p>
                <div className="grid gap-2">
                  {financialData.featureFlags.map((flag) => (
                    <div key={flag.key} className="rounded-md border border-black/10 bg-[#fafafa] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold">{flag.key}</span>
                        <span className="rounded-full border border-black/10 bg-white px-2 py-1 text-xs font-semibold uppercase">{flag.state}</span>
                      </div>
                      <p className="mt-1 text-xs">Versión {flag.version} · corte {flag.cutover_at ? formatHnDateTime(flag.cutover_at) : "sin activar"}</p>
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        </section>
      ) : null}

      {activeTab === "mappings" ? (
        <section className="space-y-5">
          <div className="rounded-lg border border-black/10 bg-white p-4 shadow-sm sm:p-5">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Settings2 size={19} />
                  <h2 className="text-lg font-semibold">Configuración contable</h2>
                </div>
                <p className="mt-1 text-sm text-black/55">Mapeos base para automatización futura.</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  value={automationMode}
                  onChange={(event) => setAutomationMode(event.target.value as AutomationMode)}
                  disabled={!canConfigureAccounting || isPending}
                  className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15 disabled:cursor-not-allowed disabled:bg-[#f4f4f5]"
                >
                  {phase2AAutomationModes.map((mode) => (
                    <option key={mode} value={mode}>{accountingAutomationModeLabels[mode]}</option>
                  ))}
                </select>
                {canConfigureAccounting ? (
                  <Button onClick={saveAutomationMode} disabled={isPending} variant="dark">
                    <Save size={16} />
                    Guardar modo
                  </Button>
                ) : null}
              </div>
            </div>

            {!canConfigureAccounting ? (
              <p className="mb-4 rounded-md border border-black/10 bg-[#fafafa] p-3 text-sm text-black/60">
                Tienes acceso de lectura. No puedes crear ni editar mapeos contables.
              </p>
            ) : null}

            <div className="grid gap-3">
              {financialData.readinessItems.map((item) => (
                <article key={item.key} className="grid gap-3 rounded-md border border-black/10 bg-[#fafafa] p-3 lg:grid-cols-[minmax(180px,1fr)_minmax(220px,1.4fr)_auto] lg:items-end">
                  <div>
                    <p className="font-semibold">{item.label}</p>
                    <p className="mt-1 text-sm text-black/55">{accountingMappingTypeLabels[item.mappingType]} · {getAccountingMappingDisplayLabel(item.sourceKey)}</p>
                    <MappingStatusBadge status={item.status} />
                  </div>
                  <AccountingAccountCombobox
                    value={selectedAccounts[item.key] ?? ""}
                    selectedOption={selectedAccountOptions[item.key] ?? null}
                    disabled={!canConfigureAccounting || isPending}
                    label="Cuenta contable"
                    onChange={(account) => {
                      setSelectedAccounts((current) => ({ ...current, [item.key]: account?.id ?? "" }));
                      setSelectedAccountOptions((current) => ({ ...current, [item.key]: account }));
                    }}
                  />
                  {canConfigureAccounting ? (
                    <Button onClick={() => saveMapping(item.key)} disabled={isPending} variant="dark" className="h-10">
                      <Save size={16} />
                      Guardar
                    </Button>
                  ) : null}
                </article>
              ))}
            </div>
          </div>

          <MappingsTable mappings={financialData.mappings} canConfigureAccounting={canConfigureAccounting} isPending={isPending} onToggle={toggleMapping} />
        </section>
      ) : null}

      {activeTab === "events" ? (
        <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Activity size={19} />
                <h2 className="text-lg font-semibold">Eventos financieros</h2>
              </div>
              <p className="mt-1 text-sm text-black/55">
                Los abonos crean un evento recuperable y, cuando son válidos, una partida en borrador. Nunca se publican automáticamente.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant={eventFilter === "pending" ? "dark" : "ghost"}
                onClick={reviewPendingEvents}
                disabled={isPending}
              >
                <SearchCheck size={16} />
                Ver eventos pendientes
              </Button>
              {canScanEvents ? (
                <div>
                  <Button onClick={scanFinancialEvents} disabled={isPending} variant="dark">
                    <RefreshCw size={16} />
                    Escanear eventos
                  </Button>
                  <p className="mt-1 max-w-52 text-xs text-black/45">Escribe datos y detecta operaciones históricas; no es un dry run.</p>
                </div>
              ) : null}
            </div>
          </div>

          <form method="get" className="mb-4 grid gap-3 rounded-md border border-black/10 bg-[#fafafa] p-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_180px_210px_auto]">
            <input type="hidden" name="tab" value="events" />
            <label className="grid gap-1 text-xs font-semibold text-black/55">
              Buscar abono, CxC o cliente
              <input
                name="event_search"
                defaultValue={financialData.eventQuery.search}
                maxLength={80}
                className="h-10 min-w-0 rounded-md border border-black/15 bg-white px-3 text-sm text-black"
                placeholder="ID parcial o cliente"
              />
            </label>
            <label className="grid gap-1 text-xs font-semibold text-black/55">
              Estado
              <select name="event_status" defaultValue={financialData.eventQuery.status} className="h-10 min-w-0 rounded-md border border-black/15 bg-white px-3 text-sm text-black">
                <option value="">Todos</option>
                {Object.entries(eventStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-semibold text-black/55">
              Tipo
              <select name="event_purpose" defaultValue={financialData.eventQuery.purpose} className="h-10 min-w-0 rounded-md border border-black/15 bg-white px-3 text-sm text-black">
                <option value="">Todos</option>
                <option value="receivable_payment">Abono recibido</option>
                <option value="receivable_paid">Cuenta por cobrar pagada</option>
              </select>
            </label>
            <Button type="submit" variant="dark" className="self-end">
              Buscar
            </Button>
          </form>

          <div className="mb-4 rounded-md border border-[#bfdbfe] bg-[#eff6ff] p-3 text-sm text-[#1e3a8a]">
            <p className="font-semibold">Cuenta por cobrar pagada</p>
            <p className="mt-1">
              La cuenta por cobrar pagada es un evento de control. El movimiento contable se registra mediante cada abono recibido.
            </p>
          </div>

          <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar eventos por módulo">
            <button
              type="button"
              onClick={() => setEventFilter("all")}
              aria-pressed={eventFilter === "all"}
              className={`rounded-md border px-3 py-2 text-sm font-semibold ${eventFilter === "all" ? "border-[#080808] bg-[#080808] text-white" : "border-black/10 bg-white text-black/65"}`}
            >
              Todos
            </button>
            <button
              type="button"
              onClick={() => setEventFilter("pending")}
              aria-pressed={eventFilter === "pending"}
              className={`rounded-md border px-3 py-2 text-sm font-semibold ${eventFilter === "pending" ? "border-[#080808] bg-[#080808] text-white" : "border-black/10 bg-white text-black/65"}`}
            >
              Pendientes
            </button>
            <button type="button" onClick={() => setEventFilter("sales_v2")} aria-pressed={eventFilter === "sales_v2"} className={`rounded-md border px-3 py-2 text-sm font-semibold ${eventFilter === "sales_v2" ? "border-[#080808] bg-[#080808] text-white" : "border-black/10 bg-white text-black/65"}`}>Ventas V2</button>
            <button type="button" onClick={() => setEventFilter("cogs_v2")} aria-pressed={eventFilter === "cogs_v2"} className={`rounded-md border px-3 py-2 text-sm font-semibold ${eventFilter === "cogs_v2" ? "border-[#080808] bg-[#080808] text-white" : "border-black/10 bg-white text-black/65"}`}>COGS V2</button>
            <button type="button" onClick={() => setEventFilter("supplier_v2")} aria-pressed={eventFilter === "supplier_v2"} className={`rounded-md border px-3 py-2 text-sm font-semibold ${eventFilter === "supplier_v2" ? "border-[#080808] bg-[#080808] text-white" : "border-black/10 bg-white text-black/65"}`}>Proveedores V2</button>
            <button type="button" onClick={() => setEventFilter("drafts")} aria-pressed={eventFilter === "drafts"} className={`rounded-md border px-3 py-2 text-sm font-semibold ${eventFilter === "drafts" ? "border-[#080808] bg-[#080808] text-white" : "border-black/10 bg-white text-black/65"}`}>Borradores</button>
            </div>
            <label className="grid min-w-0 gap-1 text-xs font-semibold text-black/55 sm:min-w-56">
              Estado outbox V2
              <select
                value={outboxStatusFilter}
                onChange={(event) => setOutboxStatusFilter(event.target.value as typeof outboxStatusFilter)}
                className="h-11 min-w-0 rounded-md border border-black/15 bg-white px-3 text-sm text-black"
              >
                <option value="all">Todos los estados</option>
                <option value="queued">En cola</option>
                <option value="processing">Procesando</option>
                <option value="pending_mapping">Mapping pendiente</option>
                <option value="pending_data">Dato pendiente</option>
                <option value="failed">Fallido</option>
                <option value="completed">Completado</option>
                <option value="shadow_validated">Shadow validado</option>
                <option value="cancelled">Cancelado</option>
              </select>
            </label>
          </div>

          {hasEvents ? (
            <div className="min-w-0 max-w-full overflow-x-auto rounded-md border border-black/10">
              <table className="w-full min-w-[1340px] text-left text-sm [&_td]:break-words [&_td]:[overflow-wrap:anywhere]">
                <thead className="bg-[#f3f4f6] text-xs uppercase text-black/50">
                  <tr>
                    <th className="px-3 py-3">Tipo de evento</th>
                    <th className="px-3 py-3">Origen</th>
                    <th className="px-3 py-3">Monto</th>
                    <th className="px-3 py-3">Detalle</th>
                    <th className="px-3 py-3">Fecha</th>
                    <th className="px-3 py-3">Partida asociada</th>
                    <th className="px-3 py-3">Estado</th>
                    <th className="px-3 py-3">Intentos</th>
                    <th className="px-3 py-3">Motivo / validación</th>
                    <th className="px-3 py-3">Creado</th>
                    {canGenerateDrafts || canRetryPaymentEvents ? <th className="px-3 py-3">Acción</th> : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {visibleEvents.map((event) => {
                    const amount = eventAmount(event);
                    const detail = eventDetail(event);
                    const sourceNumber = snapshotText(event.source_snapshot, ["source_number", "order_number", "purchase_number", "invoice_number", "supplier_payment_id", "accounts_payable_id", "inventory_movement_id"]);
                    const pendingConcept = pendingConceptMessage(event.outbox?.missing_key);
                    const issues = [
                      ...validationMessages(event.validation_errors),
                      ...(event.outbox?.last_error ? [event.outbox.last_error] : []),
                      ...(pendingConcept ? [pendingConcept] : []),
                    ];
                    const linkedDraft = event.journal_entry;
                    const originHref = resolveAccountingOriginHref(event.source_type, event.source_id);
                    const canGenerateDraft = canGenerateDrafts && canGenerateDraftForEvent(event);
                    const canRetryPayment = Boolean(
                      canRetryPaymentEvents &&
                      event.source_type === "receivable_payment" &&
                      event.event_purpose === "receivable_payment" &&
                      !event.journal_entry_id &&
                      event.outbox?.id &&
                      ["pending", "ready", "failed"].includes(event.status),
                    );
                    const canRetryV2 = Boolean(
                      canRetryPaymentEvents
                      && event.posting_version === "v2"
                      && !event.journal_entry_id
                      && event.outbox?.id
                      && ["failed", "pending_mapping", "pending_data"].includes(event.outbox.status),
                    );

                    return (
                      <tr key={event.id}>
                        <td className="px-3 py-3">
                          <p className="font-medium">{eventPurposeLabels[event.event_purpose] ?? "Evento contable"}</p>
                          <p className="text-xs text-black/45">{event.outbox?.module ?? event.source_type} · {event.posting_version}</p>
                          {event.outbox?.scenario ? <p className="text-xs text-black/45">{event.outbox.scenario}</p> : null}
                        </td>
                        <td className="px-3 py-3">
                          <p className="font-medium">{sourceTypeLabels[event.source_type] ?? "Origen operativo"}</p>
                          <p className="text-xs text-black/45">{shortReference(sourceNumber ?? event.source_id) ?? "Referencia operativa"}</p>
                          {originHref ? (
                            <a href={originHref} className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-md border border-black/10 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#080808] hover:border-[#e4252c]/30 hover:bg-[#fff1f2]">
                              <ExternalLink size={13} />
                              Ver origen
                            </a>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 font-medium">{amount === undefined || amount === null ? "-" : formatCurrency(amount)}</td>
                        <td className="px-3 py-3">
                          <p className="font-medium">{detail.title}</p>
                          {detail.helper ? <p className="text-xs text-black/45">{detail.helper}</p> : null}
                        </td>
                        <td className="px-3 py-3">
                          <p>{formatHnDateTime(event.occurred_at)}</p>
                          {formatAccountingDate(event.accounting_date) ? <p className="text-xs font-medium text-black/55">Contable: {formatAccountingDate(event.accounting_date)}</p> : null}
                          {event.outbox?.cutover_at ? <p className="text-xs text-black/45">Corte: {formatHnDateTime(event.outbox.cutover_at)}</p> : null}
                        </td>
                        <td className="px-3 py-3">
                          {linkedDraft ? (
                            <div>
                              <p className="font-medium">{linkedDraft.entry_number}</p>
                              <Link href={buildJournalEntryViewerHref(linkedDraft.id)} className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-md border border-black/10 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#080808] hover:border-[#e4252c]/30 hover:bg-[#fff1f2]">
                                <ExternalLink size={13} />
                                Ver partida contable
                              </Link>
                            </div>
                          ) : event.journal_entry_id ? (
                            <p className="font-medium">Partida vinculada</p>
                          ) : (
                            <span className="text-black/45">Sin partida</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <EventStatusBadge status={event.status} label={eventStatusText(event)} />
                        </td>
                        <td className="px-3 py-3">
                          <p className="font-medium">{event.outbox?.attempts ?? 0}</p>
                          <p className="text-xs text-black/45">{event.outbox?.status ?? "Sin outbox"}</p>
                          {event.outbox?.next_attempt_at ? <p className="text-xs text-black/45">Próximo: {formatHnDateTime(event.outbox.next_attempt_at)}</p> : null}
                          {event.outbox?.duplicate_avoided ? <p className="text-xs font-semibold text-[#166534]">Duplicado evitado</p> : null}
                          {event.outbox?.compensated_event_id ? <p className="text-xs font-semibold text-[#7c2d12]">Evento compensatorio</p> : null}
                        </td>
                        <td className="px-3 py-3">
                          {issues.length > 0 ? (
                            <div className="max-w-[300px] space-y-1 text-xs text-[#7c2d12]">
                              {issues.map((issue, index) => {
                                const label = validationIssueLabel(issue);
                                return <p key={`${event.id}-${index}`}>{label ? <span className="font-semibold">{label}: </span> : null}{issue}</p>;
                              })}
                            </div>
                          ) : (
                            <span className="text-black/45">Sin observaciones</span>
                          )}
                        </td>
                                                <td className="px-3 py-3">{formatHnDateTime(event.created_at)}</td>
                        {canGenerateDrafts || canRetryPaymentEvents ? (
                          <td className="min-w-40 px-3 py-3">
                            <div className="flex flex-col gap-2">
                            {canRetryPayment && event.outbox ? (
                              <Button variant="ghost" disabled={isPending} onClick={() => retryPaymentEvent(event.outbox!.id)}>
                                <RefreshCw size={16} />
                                Reintentar procesamiento
                              </Button>
                            ) : null}
                            {canRetryV2 && event.outbox ? (
                              <Button className="min-h-11 whitespace-nowrap [overflow-wrap:normal]" variant="ghost" disabled={isPending} onClick={() => retryV2Event(event.outbox!.id)}>
                                <RefreshCw size={16} />
                                Reintentar V2
                              </Button>
                            ) : null}
                            {canGenerateDraft && !canRetryPayment && !canRetryV2 ? (
                              <Button variant="ghost" disabled={isPending} onClick={() => generateDraft(event.id)}>
                                <FilePlus2 size={16} />
                                Generar borrador
                              </Button>
                            ) : null}
                            {!canRetryPayment && !canRetryV2 && !canGenerateDraft ? (
                              <span className="text-xs text-black/45">{event.journal_entry_id ? "Vinculado" : "No aplica"}</span>
                            ) : null}
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-black/15 bg-[#fafafa] p-5 text-sm text-black/60">
              <p className="font-semibold text-black">Sin eventos financieros registrados</p>
              <p className="mt-1">El escaneo no encontró eventos para mostrar en este filtro.</p>
            </div>
          )}

          <div className="mt-4 flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
            <p className="text-black/50">
              Página {financialData.eventPagination.page} de {financialData.eventPagination.totalPages} · {financialData.eventPagination.total} eventos
            </p>
            <div className="flex gap-2">
              {financialData.eventPagination.page > 1 ? (
                <Link href={eventPageHref(financialData.eventPagination.page - 1)} className="rounded-md border border-black/10 px-3 py-2 font-semibold">
                  Anterior
                </Link>
              ) : null}
              {financialData.eventPagination.page < financialData.eventPagination.totalPages ? (
                <Link href={eventPageHref(financialData.eventPagination.page + 1)} className="rounded-md border border-black/10 px-3 py-2 font-semibold">
                  Siguiente
                </Link>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === "journal" ? (
        <div className="space-y-5">
          {hasFocusedRequest && focusedEntryStatus !== "loaded" ? (
            <FocusedEntryError
              status={focusedEntryStatus}
              onRetry={() => router.refresh()}
              onBackToJournal={closeFocusedEntry}
              onBackToCenter={() => selectTab("summary")}
            />
          ) : null}
          <AccountingManager
            data={accountingData}
            canManage={canManage}
            canCreate={canCreate}
            canEdit={canEditDrafts}
            canPost={canPost}
            canReverse={canReverse}
            canExport={canExportAccounting}
            canCsvExport={canExportTechnicalCsv}
            focusedEntryData={hasFocusedRequest && focusedEntryStatus === "loaded" ? focusedEntryData : null}
            focusedEntryId={hasFocusedRequest ? focusedEntryId : null}
            onCloseFocusedEntry={closeFocusedEntry}
            visibleSections={["journal", "entries"]}
          />
        </div>
      ) : null}

      {activeTab === "accounts" ? (
        <AccountingManager
          data={accountingData}
          canManage={canManage}
          canCreate={canCreate}
          canEdit={canEditDrafts}
          canPost={canPost}
          canReverse={canReverse}
          canExport={canExportAccounting}
          canCsvExport={canExportTechnicalCsv}
          visibleSections={["summary", "accounts"]}
        />
      ) : null}

      {message ? <p className="rounded-lg border border-black/10 bg-white p-3 text-sm text-black/65">{message}</p> : null}
    </div>
  );
}

function FocusedEntryError({
  status,
  onRetry,
  onBackToJournal,
  onBackToCenter,
}: {
  status: JournalEntryViewerStatus;
  onRetry: () => void;
  onBackToJournal: () => void;
  onBackToCenter: () => void;
}) {
  const message = status === "invalid"
    ? "Identificador de partida contable inválido."
    : status === "not_found"
      ? "No se encontró la partida contable solicitada."
      : "No fue posible cargar la partida contable. Intente nuevamente.";

  return (
    <section role="alert" className="rounded-lg border border-[#e4252c]/25 bg-[#fff1f2] p-4 text-[#7f1d1d] shadow-sm sm:p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 shrink-0" size={20} aria-hidden="true" />
        <div>
          <h2 className="font-semibold">No se pudo abrir la partida</h2>
          <p className="mt-1 text-sm">{message}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {status !== "invalid" ? <Button type="button" variant="dark" onClick={onRetry}>Reintentar</Button> : null}
        <Button type="button" variant="ghost" onClick={onBackToJournal}>Volver al Libro diario</Button>
        <Button type="button" variant="ghost" onClick={onBackToCenter}>Volver al Centro Financiero</Button>
      </div>
    </section>
  );
}

function SummaryCard({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <article className="rounded-lg border border-black/10 bg-white p-4 shadow-sm">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 break-words text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-sm text-black/55">{helper}</p>
    </article>
  );
}

function StatusPill({ status }: { status: FinancialReadinessStatus }) {
  return (
    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${readinessClasses[status]}`}>
      {readinessLabels[status]}
    </span>
  );
}

function MappingStatusBadge({ status }: { status: MappingReadinessStatus }) {
  const className = {
    configured: "bg-[#edf7ed] text-[#2f6f3e]",
    pending: "bg-[#fff7ed] text-[#7c2d12]",
    inactive: "bg-[#fff1f2] text-[#b91c25]",
  }[status];

  return <span className={`mt-2 inline-flex rounded-full px-2 py-1 text-xs font-semibold ${className}`}>{mappingStatusLabels[status]}</span>;
}

function EventStatusBadge({ status, label }: { status: FinancialEventStatus; label?: string }) {
  const className = {
    pending: "bg-[#fff7ed] text-[#7c2d12]",
    ready: "bg-[#edf7ed] text-[#2f6f3e]",
    draft_created: "bg-[#eef2ff] text-[#3730a3]",
    posted: "bg-[#edf7ed] text-[#2f6f3e]",
    failed: "bg-[#fff1f2] text-[#b91c25]",
    skipped: "bg-[#f4f4f5] text-black/55",
    reversed: "bg-[#eef2ff] text-[#3730a3]",
  }[status];

  return <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${className}`}>{label ?? eventStatusLabels[status]}</span>;
}

function MappingsTable({
  mappings,
  canConfigureAccounting,
  isPending,
  onToggle,
}: {
  mappings: AccountingMapping[];
  canConfigureAccounting: boolean;
  isPending: boolean;
  onToggle: (mapping: AccountingMapping) => void;
}) {
  return (
    <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Clock size={19} />
        <h2 className="text-lg font-semibold">Mapeos contables</h2>
      </div>
      <div className="overflow-x-auto rounded-md border border-black/10">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="bg-[#f3f4f6] text-xs uppercase text-black/50">
            <tr>
              <th className="px-3 py-3">Tipo</th>
              <th className="px-3 py-3">Concepto</th>
              <th className="px-3 py-3">Cuenta contable</th>
              <th className="px-3 py-3">Prioridad</th>
              <th className="px-3 py-3">Estado</th>
              {canConfigureAccounting ? <th className="px-3 py-3">Acción</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-black/10">
            {mappings.map((mapping) => (
              <tr key={mapping.id}>
                <td className="px-3 py-3">{accountingMappingTypeLabels[mapping.mapping_type]}</td>
                <td className="px-3 py-3 font-medium">{getAccountingMappingDisplayLabel(mapping.source_key)}</td>
                <td className="px-3 py-3">
                  {mapping.account ? `${mapping.account.code} - ${mapping.account.name}` : "Cuenta no configurada"}
                </td>
                <td className="px-3 py-3">{mapping.priority}</td>
                <td className="px-3 py-3">
                  <span className={`rounded-full px-2 py-1 text-xs font-semibold ${mapping.is_active ? "bg-[#edf7ed] text-[#2f6f3e]" : "bg-[#f4f4f5] text-black/55"}`}>
                    {mapping.is_active ? "Activo" : "Inactivo"}
                  </span>
                </td>
                {canConfigureAccounting ? (
                  <td className="px-3 py-3">
                    <Button variant="ghost" disabled={isPending} onClick={() => onToggle(mapping)}>
                      {mapping.is_active ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                      {mapping.is_active ? "Desactivar" : "Activar"}
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
            {mappings.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-black/55" colSpan={canConfigureAccounting ? 6 : 5}>
                  No hay mapeos contables registrados.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
