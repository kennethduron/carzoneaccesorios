"use client";

import { useMemo, useState, useTransition } from "react";
import { Activity, AlertTriangle, BookOpen, CheckCircle2, Clock, FilePlus2, Landmark, LayoutDashboard, RefreshCw, Save, SearchCheck, Settings2, SlidersHorizontal, ToggleLeft, ToggleRight } from "lucide-react";
import {
  generateJournalDraftFromFinancialEventAction,
  saveAccountingMappingAction,
  scanFinancialEventsAction,
  toggleAccountingMappingAction,
  updateAutomationModeAction,
} from "@/app/admin/contabilidad/actions";
import { AccountingManager } from "@/components/admin/accounting-manager";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import {
  accountingAutomationModeLabels,
  phase2AAutomationModes,
  accountingMappingTypeLabels,
} from "@/services/supabase/accounting-config.service";
import type { AccountingPageData } from "@/types/accounting";
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
  canManage: boolean;
  canCreate: boolean;
  canPost: boolean;
  canReverse: boolean;
  canConfigureAccounting: boolean;
  canScanEvents: boolean;
  canGenerateDrafts: boolean;
};

type TabKey = "summary" | "settings" | "events" | "journal" | "accounts";

const tabs: Array<{ key: TabKey; label: string; icon: typeof LayoutDashboard }> = [
  { key: "summary", label: "Resumen financiero", icon: LayoutDashboard },
  { key: "settings", label: "Configuración contable", icon: Settings2 },
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
const purchaseApEventPurposes = new Set(["purchase_confirmed", "supplier_invoice_received", "accounts_payable_created", "supplier_payment", "supplier_payment_cancelled", "purchase_cancelled"]);

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
]);

const draftEligibleStatuses = new Set<FinancialEventStatus>(["pending", "ready", "failed"]);

const eventPurposeLabels: Record<string, string> = {
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
  purchase_cancelled: "Compra anulada",
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

function validationMessages(value: unknown[]) {
  return value.map((item) => String(item)).filter(Boolean);
}

function eventAmount(event: FinancialEvent) {
  return event.source_snapshot.total_cost_snapshot ?? event.source_snapshot.amount ?? event.source_snapshot.total ?? event.source_snapshot.total_amount ?? event.source_snapshot.original_amount;
}

function eventDetail(event: FinancialEvent) {
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
    const documentNumber = snapshotText(event.source_snapshot, ["purchase_number", "invoice_number", "supplier_payment_id", "accounts_payable_id"]);
    const status = snapshotText(event.source_snapshot, ["status"]);
    const date = snapshotText(event.source_snapshot, ["purchase_date", "invoice_date", "due_date", "paid_at"]);
    const total = event.source_snapshot.total ?? event.source_snapshot.total_amount ?? event.source_snapshot.amount;
    const balance = event.source_snapshot.balance;
    return {
      title: supplier,
      helper: [
        documentNumber ? `Documento ${documentNumber}` : null,
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

function eventStatusText(event: FinancialEvent) {
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
  if (issue.includes("costo del producto")) return "Costo del producto faltante";
  if (issue.includes("Merma") || issue.includes("merma")) return "Merma de inventario";
  return null;
}

function canGenerateDraftForEvent(event: FinancialEvent) {
  return !event.journal_entry_id && draftEligiblePurposes.has(event.event_purpose) && draftEligibleStatuses.has(event.status);
}

export function FinancialCenterManager({
  accountingData,
  financialData,
  canManage,
  canCreate,
  canPost,
  canReverse,
  canConfigureAccounting,
  canScanEvents,
  canGenerateDrafts,
}: FinancialCenterManagerProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("summary");
  const [eventFilter, setEventFilter] = useState<"all" | "pending">("all");
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(financialData.readinessItems.map((item) => [item.key, item.account?.id ?? ""])),
  );
  const [automationMode, setAutomationMode] = useState<AutomationMode>(financialData.summary.automationMode);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  const activeAccounts = accountingData.activeAccounts;
  const configuredLabel = `${formatNumber(financialData.summary.configuredMappings)} de ${formatNumber(financialData.readinessItems.length)}`;
  const visibleEvents = eventFilter === "pending"
    ? financialData.events.filter((event) => event.status === "pending")
    : financialData.events;
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
    setActiveTab("events");
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

  return (
    <div className="space-y-5">
      <nav className="flex gap-2 overflow-x-auto rounded-lg border border-black/10 bg-white p-2 shadow-sm" aria-label="Secciones de contabilidad">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
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
            <SummaryCard label="Modo de automatización" value={accountingAutomationModeLabels[financialData.summary.automationMode]} helper="Sin publicación automática en esta fase" />
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
                          {accountingMappingTypeLabels[item.mappingType]} · {item.sourceKey}
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
                  El motor de eventos financieros no genera partidas automáticas ni modifica ventas, pagos, facturas o inventario.
                </p>
              </div>
            </aside>
          </div>
        </section>
      ) : null}

      {activeTab === "settings" ? (
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
                    <p className="mt-1 text-sm text-black/55">{accountingMappingTypeLabels[item.mappingType]} · {item.sourceKey}</p>
                    <MappingStatusBadge status={item.status} />
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase text-black/50">Cuenta contable</span>
                    <select
                      value={selectedAccounts[item.key] ?? ""}
                      onChange={(event) => setSelectedAccounts((current) => ({ ...current, [item.key]: event.target.value }))}
                      disabled={!canConfigureAccounting || isPending}
                      className="h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15 disabled:cursor-not-allowed disabled:bg-[#f4f4f5]"
                    >
                      <option value="">Cuenta no configurada</option>
                      {activeAccounts.map((account) => (
                        <option key={account.id} value={account.id}>{account.code} - {account.name}</option>
                      ))}
                    </select>
                  </label>
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
              <p className="mt-1 text-sm text-black/55">Registro de eventos detectados desde datos operativos. No se crean partidas automáticas.</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant={eventFilter === "pending" ? "dark" : "ghost"}
                onClick={reviewPendingEvents}
                disabled={isPending}
              >
                <SearchCheck size={16} />
                Revisar eventos pendientes
              </Button>
              {canScanEvents ? (
                <Button onClick={scanFinancialEvents} disabled={isPending} variant="dark">
                  <RefreshCw size={16} />
                  Escanear eventos
                </Button>
              ) : null}
            </div>
          </div>

          <div className="mb-3 flex gap-2">
            <button
              type="button"
              onClick={() => setEventFilter("all")}
              className={`rounded-md border px-3 py-2 text-sm font-semibold ${eventFilter === "all" ? "border-[#080808] bg-[#080808] text-white" : "border-black/10 bg-white text-black/65"}`}
            >
              Todos
            </button>
            <button
              type="button"
              onClick={() => setEventFilter("pending")}
              className={`rounded-md border px-3 py-2 text-sm font-semibold ${eventFilter === "pending" ? "border-[#080808] bg-[#080808] text-white" : "border-black/10 bg-white text-black/65"}`}
            >
              Pendientes
            </button>
          </div>

          {hasEvents ? (
            <div className="overflow-x-auto rounded-md border border-black/10">
              <table className="w-full min-w-[1340px] text-left text-sm">
                <thead className="bg-[#f3f4f6] text-xs uppercase text-black/50">
                  <tr>
                    <th className="px-3 py-3">Tipo de evento</th>
                    <th className="px-3 py-3">Origen</th>
                    <th className="px-3 py-3">Monto</th>
                    <th className="px-3 py-3">Detalle</th>
                    <th className="px-3 py-3">Fecha</th>
                    <th className="px-3 py-3">Partida asociada</th>
                    <th className="px-3 py-3">Estado</th>
                    <th className="px-3 py-3">Motivo / validación</th>
                    <th className="px-3 py-3">Creado</th>
                    {canGenerateDrafts ? <th className="px-3 py-3">Acción</th> : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {visibleEvents.map((event) => {
                    const amount = eventAmount(event);
                    const detail = eventDetail(event);
                    const sourceNumber = snapshotText(event.source_snapshot, ["source_number", "order_number", "purchase_number", "invoice_number", "supplier_payment_id", "accounts_payable_id", "inventory_movement_id"]);
                    const issues = validationMessages(event.validation_errors);
                    const linkedDraft = event.journal_entry;
                    const canGenerateDraft = canGenerateDrafts && canGenerateDraftForEvent(event);

                    return (
                      <tr key={event.id}>
                        <td className="px-3 py-3">
                          <p className="font-medium">{eventPurposeLabels[event.event_purpose] ?? event.event_purpose}</p>
                          <p className="text-xs text-black/45">{event.posting_version}</p>
                        </td>
                        <td className="px-3 py-3">
                          <p className="font-medium">{sourceTypeLabels[event.source_type] ?? event.source_type}</p>
                          <p className="text-xs text-black/45">{sourceNumber ?? event.source_id}</p>
                          <p className="text-xs text-black/35">{event.source_id}</p>
                        </td>
                        <td className="px-3 py-3 font-medium">{amount === undefined || amount === null ? "-" : formatCurrency(amount)}</td>
                        <td className="px-3 py-3">
                          <p className="font-medium">{detail.title}</p>
                          {detail.helper ? <p className="text-xs text-black/45">{detail.helper}</p> : null}
                        </td>
                        <td className="px-3 py-3">{formatHnDateTime(event.occurred_at)}</td>
                        <td className="px-3 py-3">
                          {linkedDraft ? (
                            <p className="font-medium">{linkedDraft.entry_number}</p>
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
                        {canGenerateDrafts ? (
                          <td className="px-3 py-3">
                            {canGenerateDraft ? (
                              <Button variant="ghost" disabled={isPending} onClick={() => generateDraft(event.id)}>
                                <FilePlus2 size={16} />
                                Generar borrador
                              </Button>
                            ) : (
                              <span className="text-xs text-black/45">{event.journal_entry_id ? "Vinculado" : "No aplica"}</span>
                            )}
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
        </section>
      ) : null}

      {activeTab === "journal" ? (
        <AccountingManager
          data={accountingData}
          canManage={canManage}
          canCreate={canCreate}
          canPost={canPost}
          canReverse={canReverse}
          visibleSections={["journal", "entries"]}
        />
      ) : null}

      {activeTab === "accounts" ? (
        <AccountingManager
          data={accountingData}
          canManage={canManage}
          canCreate={canCreate}
          canPost={canPost}
          canReverse={canReverse}
          visibleSections={["summary", "accounts"]}
        />
      ) : null}

      {message ? <p className="rounded-lg border border-black/10 bg-white p-3 text-sm text-black/65">{message}</p> : null}
    </div>
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
              <th className="px-3 py-3">Clave</th>
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
                <td className="px-3 py-3 font-medium">{mapping.source_key}</td>
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
