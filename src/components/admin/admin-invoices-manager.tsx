"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Download, ExternalLink, Eye, FilePenLine, FileSpreadsheet, FileText, Printer } from "lucide-react";
import {
  cancelInvoiceAction,
  getInvoiceDetailAction,
  updateInvoiceCustomerDataAction,
} from "@/app/admin/facturas/actions";
import { AccountingTraceabilityCard } from "@/components/admin/accounting-traceability-card";
import { ActiveFilterBanner } from "@/components/admin/active-filter-banner";
import { FiscalAlertsPanel } from "@/components/admin/fiscal-alerts-panel";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { OfficialInvoiceDocument } from "@/components/invoices/official-invoice-document";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { FiscalAlert } from "@/types/fiscal";
import type { AdminInvoiceDetail, AdminInvoiceRow, InvoiceStatus } from "@/types/invoices";
import { formatHnDate } from "@/utils/format";
import { adminInvoiceToOfficialInvoice } from "@/utils/invoice-document-mappers";
import { buildOfficialInvoicePrintHtml } from "@/utils/official-invoice-document";
import { paymentMethodLabel } from "@/utils/payment-labels";
import { formatCurrency } from "@/utils/pricing";
import type { FiscalCorrectionHistoryEntry, FiscalCorrectionValueKey } from "@/types/fiscal-corrections";

type AdminInvoicesManagerProps = {
  invoices: AdminInvoiceRow[];
  total: number;
  page: number;
  pageSize: number;
  fiscalAlerts: FiscalAlert[];
  canCancelInvoices: boolean;
  canCorrectInvoices: boolean;
  canUseTechnicalExports: boolean;
  errorMessage?: string | null;
  activeTask?: { id: string; label: string } | null;
};

const statusLabels: Record<InvoiceStatus, string> = {
  emitida: "Emitida",
  anulada: "Anulada",
  pendiente: "Pendiente",
  draft: "Pendiente",
  issued: "Emitida",
  paid: "Pagada",
  cancelled: "Anulada",
};

const fiscalCorrectionFieldLabels: Record<FiscalCorrectionValueKey, string> = {
  customer_name: "Nombre fiscal",
  customer_rtn: "RTN",
  customer_phone: "Teléfono",
  customer_email: "Correo electrónico",
  customer_address: "Dirección fiscal",
};

const fiscalCorrectionWarning =
  "Esta acción actualizará datos fiscales del cliente. Si la factura ya fue emitida, conservará el mismo número fiscal y quedará registrada en auditoría.";

function formatDate(value: string | null) {
  const dateOnly = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  }

  return formatHnDate(value);
}

function csvEscape(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function downloadBlob(content: string, fileName: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function adminInvoicePdfHref(invoiceId: string, download = false) {
  const href = `/api/admin/facturas/${encodeURIComponent(invoiceId)}/pdf`;
  return download ? `${href}?download=1` : href;
}

function htmlEscape(value: string | number) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildExcelTable(title: string, columns: string[], rows: Array<Array<string | number>>) {
  const header = columns.map((column) => `<th>${htmlEscape(column)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((value) => `<td>${htmlEscape(value)}</td>`).join("")}</tr>`)
    .join("");

  return `
    <html>
      <head><meta charset="utf-8" /></head>
      <body>
        <h1>${htmlEscape(title)}</h1>
        <table border="1">
          <thead><tr>${header}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </body>
    </html>
  `;
}

export function AdminInvoicesManager({
  invoices,
  total,
  page,
  pageSize,
  fiscalAlerts,
  canCancelInvoices,
  canCorrectInvoices,
  canUseTechnicalExports,
  errorMessage = null,
  activeTask = null,
}: AdminInvoicesManagerProps) {
  const router = useRouter();
  const [status, setStatus] = useState<InvoiceStatus | "all">("all");
  const [paymentMethod, setPaymentMethod] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState<AdminInvoiceDetail | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [invoiceToCancel, setInvoiceToCancel] = useState<AdminInvoiceRow | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  const debouncedQuery = useDebouncedValue(query, 400);

  function showInvoiceMessage(nextMessage: string, ok: boolean) {
    setMessage(nextMessage);
    if (ok) {
      toast.success(nextMessage);
    } else {
      toast.error(nextMessage);
    }
  }

  const filteredInvoices = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLowerCase();
    return invoices.filter((invoice) => {
      const matchesStatus = status === "all" || invoice.status === status;
      const matchesPayment = paymentMethod === "all" || invoice.payment_method === paymentMethod;
      const matchesQuery =
        !normalizedQuery ||
        `${invoice.invoice_number} ${invoice.customer_name} ${invoice.customer_rtn ?? ""} ${invoice.bank_reference_number ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery);

      return matchesStatus && matchesPayment && matchesQuery;
    });
  }, [debouncedQuery, invoices, paymentMethod, status]);

  const totals = filteredInvoices.reduce(
    (summary, invoice) => ({
      subtotal: summary.subtotal + invoice.subtotal,
      tax: summary.tax + invoice.tax,
      total: summary.total + invoice.total,
    }),
    { subtotal: 0, tax: 0, total: 0 },
  );

  function invoiceExportRows() {
    const columns = [
      "Factura",
      "Cliente",
      "RTN cliente",
      "Fecha",
      "Método de pago",
      "Referencia bancaria",
      "Subtotal antes de ISV",
      "ISV incluido 15%",
      "Recargo mínimo",
      "Descuentos",
      "Otros cargos",
      "Envío",
      "Comisión entrega",
      "Total",
      "Estado",
    ];
    const rows = filteredInvoices.map((invoice) => [
      invoice.invoice_number,
      invoice.customer_name,
      invoice.customer_rtn ?? "-",
      formatDate(invoice.issued_at ?? invoice.created_at),
      paymentMethodLabel(invoice.payment_method, { detailedCard: true }),
      invoice.bank_reference_number ?? "-",
      formatCurrency(invoice.subtotal),
      formatCurrency(invoice.tax),
      formatCurrency(invoice.small_order_fee),
      invoice.discount_total > 0 ? `-${formatCurrency(invoice.discount_total)}` : formatCurrency(0),
      formatCurrency(invoice.additional_fees.reduce((sum, fee) => sum + fee.amount, 0)),
      formatCurrency(invoice.shipping_fee),
      formatCurrency(invoice.cash_on_delivery_fee),
      formatCurrency(invoice.total),
      statusLabels[invoice.status],
    ]);

    return { columns, rows };
  }

  function exportCsv() {
    if (!canUseTechnicalExports) {
      return;
    }

    const { columns, rows } = invoiceExportRows();

    downloadBlob(
      [columns.map(csvEscape).join(","), ...rows.map((row) => row.map(csvEscape).join(","))].join("\n"),
      "car-zone-facturas.csv",
      "text/csv;charset=utf-8",
    );
  }

  function exportExcel() {
    const { columns, rows } = invoiceExportRows();
    downloadBlob(
      buildExcelTable("Facturas fiscales - Car Zone Accesorios", columns, rows),
      "car-zone-facturas.xlsx.xls",
      "application/vnd.ms-excel;charset=utf-8",
    );
  }

  function printInvoice(invoice: AdminInvoiceDetail) {
    printInvoiceDocument(invoice);
  }

  async function cancelInvoice(invoice: AdminInvoiceRow) {
    setInvoiceToCancel(invoice);
  }

  async function cancelInvoiceWithReason(invoice: AdminInvoiceRow, cancellationReason: string) {
    const confirmed = await toast.confirm({
      title: "Confirmar anulación",
      message: "Esta acción será definitiva y quedará registrada en auditoría. ¿Confirmas que deseas anular esta factura?",
      confirmLabel: "Confirmar anulación",
      cancelLabel: "Volver",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await cancelInvoiceAction(invoice.id, cancellationReason);
      showInvoiceMessage(result.message, result.ok);
      if (result.ok) {
        setInvoiceToCancel(null);
        router.refresh();
      }
    });
  }

  /*

      title: "Confirmar anulación",
      message: `¿Anular la factura ${invoice.invoice_number}? Esta acción quedará registrada.`,
      confirmLabel: "Anular factura",
      cancelLabel: "Cancelar",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await cancelInvoiceAction(invoice.id);
      showInvoiceMessage(result.message, result.ok);
    });
  }

  */

  function correctInvoiceCustomerData(input: {
    invoiceId: string;
    customerName: string;
    customerRtn: string;
    customerPhone: string;
    customerEmail: string;
    customerAddress: string;
    correctionReason: string;
  }) {
    startTransition(async () => {
      const result = await updateInvoiceCustomerDataAction(input);
      showInvoiceMessage(result.message, result.ok);
      if (result.ok) {
        router.refresh();
      }
    });
  }

  function openInvoiceDetail(invoiceId: string) {
    setLoadingDetailId(invoiceId);
    startTransition(async () => {
      const result = await getInvoiceDetailAction(invoiceId);
      setLoadingDetailId(null);
      if (!result.ok || !result.invoice) {
        showInvoiceMessage(result.message || "No se pudo cargar el detalle de la factura.", false);
        return;
      }

      setSelectedInvoice(result.invoice);
    });
  }

  return (
    <div className="space-y-5">
      {activeTask ? <ActiveFilterBanner label={activeTask.label} clearHref="/admin/facturas" /> : null}

      {errorMessage ? (
        <section className="rounded-lg border border-[#f59e0b]/30 bg-[#fffbeb] p-4 text-sm text-[#7c2d12]">
          <p className="font-semibold">No se pudo cargar la consulta solicitada</p>
          <p className="mt-1">{errorMessage}</p>
        </section>
      ) : null}

      <FiscalAlertsPanel alerts={fiscalAlerts} />

      <section className="rounded-lg border border-[#f59e0b]/30 bg-[#fffbeb] p-4 text-sm text-[#7c2d12]">
        <p className="font-semibold">Validación fiscal</p>
        <p className="mt-1">
          Antes de emitir facturas reales, valide CAI, rango y datos fiscales con la contadora.
        </p>
      </section>

      <PaginationControls
        basePath="/admin/facturas"
        page={page}
        pageSize={pageSize}
        total={total}
        label="facturas"
        params={activeTask ? { task: activeTask.id } : undefined}
      />

      <div className="grid gap-3 md:grid-cols-3">
        <Metric label="Subtotal antes de ISV" value={formatCurrency(totals.subtotal)} />
        <Metric label="ISV incluido 15%" value={formatCurrency(totals.tax)} />
        <Metric label="Total facturado" value={formatCurrency(totals.total)} />
      </div>

      <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatusGuide title="Pago pendiente" detail="Requiere validación antes de facturar." />
        <StatusGuide title="Pago confirmado" detail="Puede avanzar a emisión si los datos son correctos." />
        <StatusGuide title="Factura pendiente" detail="Documento aún no emitido fiscalmente." />
        <StatusGuide title="Factura emitida" detail="Lista para descargar o reimprimir." />
        <StatusGuide title="Factura anulada" detail="Debe conservar auditoría y motivo." />
        <StatusGuide title="Reimpresión" detail="No cambia datos fiscales, solo genera el PDF." />
      </section>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_180px_220px_auto_auto] lg:items-end">
          <label>
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">Buscar</span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Factura, cliente, RTN o referencia"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">Estado</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as InvoiceStatus | "all")}
              className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
            >
              <option value="all">Todos</option>
              <option value="emitida">Emitida</option>
              <option value="pendiente">Pendiente</option>
              <option value="draft">Borrador</option>
              <option value="anulada">Anulada</option>
            </select>
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">Método de pago</span>
            <select
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
            >
              <option value="all">Todos</option>
              <option value="bank_transfer">Transferencia bancaria</option>
              <option value="card">Tarjeta mediante enlace</option>
              <option value="cash">Efectivo</option>
              <option value="commercial_credit">Crédito comercial</option>
            </select>
          </label>
          <Button onClick={exportExcel} variant="ghost">
            <FileSpreadsheet size={16} />
            Excel
          </Button>
          {canUseTechnicalExports ? (
            <Button onClick={exportCsv} variant="ghost" title="Exportación técnica disponible solo para el Technical Owner">
              <Download size={16} />
              CSV técnico
            </Button>
          ) : null}
          <Button
            onClick={() => {
              setQuery("");
              setStatus("all");
              setPaymentMethod("all");
            }}
            variant="ghost"
          >
            Limpiar filtros
          </Button>
        </div>
        {message ? <p className="mt-3 text-sm text-black/60">{message}</p> : null}
      </section>

      <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
        <div className="border-b border-black/10 p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <FileText size={18} />
            Lista de facturas fiscales
          </h2>
          <p className="mt-1 text-sm text-black/55">{filteredInvoices.length.toLocaleString("es-HN")} facturas en esta página</p>
        </div>
        <div className="grid gap-3 p-3 md:hidden">
          {filteredInvoices.length === 0 ? (
            <p className="rounded-md bg-[#f4f4f5] p-4 text-center text-sm text-black/50">
              {activeTask?.id === "pending_invoices" && !errorMessage
                ? "No hay facturas pendientes en este momento."
                : "No se encontraron resultados con estos filtros."}
            </p>
          ) : (
            filteredInvoices.map((invoice) => (
              <article key={invoice.id} className="rounded-md border border-black/10 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-base font-semibold [overflow-wrap:anywhere]">{invoice.invoice_number}</h3>
                    <p className="mt-1 break-words text-sm text-black/60 [overflow-wrap:anywhere]">{invoice.customer_name}</p>
                    <p className="mt-1 text-xs text-black/45">Pedido: {invoice.order_number}</p>
                  </div>
                  <span className="shrink-0 rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-semibold">{statusLabels[invoice.status]}</span>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Fecha</dt>
                    <dd className="mt-1 font-medium">{formatDate(invoice.issued_at ?? invoice.created_at)}</dd>
                  </div>
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Total</dt>
                    <dd className="mt-1 font-semibold">{formatCurrency(invoice.total)}</dd>
                  </div>
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Pago</dt>
                    <dd className="mt-1 font-medium">{paymentMethodLabel(invoice.payment_method, { detailedCard: true })}</dd>
                  </div>
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Referencia</dt>
                    <dd className="mt-1 break-words font-medium [overflow-wrap:anywhere]">{invoice.bank_reference_number ?? "-"}</dd>
                  </div>
                </dl>

                <div className="mt-4 grid grid-cols-4 gap-2">
                  <IconButton label="Ver detalle" onClick={() => openInvoiceDetail(invoice.id)} disabled={loadingDetailId === invoice.id}>
                    <Eye size={16} />
                  </IconButton>
                  <IconLink label="Abrir factura PDF" href={adminInvoicePdfHref(invoice.id)}>
                    <ExternalLink size={16} />
                  </IconLink>
                  <IconLink label="Descargar PDF" href={adminInvoicePdfHref(invoice.id, true)}>
                    <Download size={16} />
                  </IconLink>
                  <IconButton label="Imprimir desde detalle" onClick={() => openInvoiceDetail(invoice.id)} disabled={loadingDetailId === invoice.id}>
                    <Printer size={16} />
                  </IconButton>
                </div>
                {canCancelInvoices ? (
                  <Button
                    onClick={() => cancelInvoice(invoice)}
                    disabled={isPending || invoice.status === "anulada"}
                    variant="ghost"
                    className="mt-2 w-full justify-center"
                  >
                    <Ban size={16} />
                    Anular
                  </Button>
                ) : null}
              </article>
            ))
          )}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">Factura</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">RTN cliente</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Método de pago</th>
                <th className="px-4 py-3">Referencia bancaria</th>
                <th className="px-4 py-3">Subtotal antes de ISV</th>
                <th className="px-4 py-3">ISV incluido 15%</th>
                <th className="px-4 py-3">Envío</th>
                <th className="px-4 py-3">Comisión</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-center text-black/50" colSpan={13}>
                    {activeTask?.id === "pending_invoices" && !errorMessage
                      ? "No hay facturas pendientes en este momento."
                      : "No se encontraron resultados con estos filtros."}
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="px-4 py-3 font-semibold">{invoice.invoice_number}</td>
                    <td className="px-4 py-3">{invoice.customer_name}</td>
                    <td className="px-4 py-3">{invoice.customer_rtn ?? "-"}</td>
                    <td className="px-4 py-3">{formatDate(invoice.issued_at ?? invoice.created_at)}</td>
                    <td className="px-4 py-3">{paymentMethodLabel(invoice.payment_method, { detailedCard: true })}</td>
                    <td className="px-4 py-3">{invoice.bank_reference_number ?? "-"}</td>
                    <td className="px-4 py-3">{formatCurrency(invoice.subtotal)}</td>
                    <td className="px-4 py-3">{formatCurrency(invoice.tax)}</td>
                    <td className="px-4 py-3">{formatCurrency(invoice.shipping_fee)}</td>
                    <td className="px-4 py-3">{formatCurrency(invoice.cash_on_delivery_fee)}</td>
                    <td className="px-4 py-3 font-semibold">{formatCurrency(invoice.total)}</td>
                    <td className="px-4 py-3">{statusLabels[invoice.status]}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <IconButton label="Ver detalle" onClick={() => openInvoiceDetail(invoice.id)} disabled={loadingDetailId === invoice.id}>
                          <Eye size={16} />
                        </IconButton>
                        <IconLink label="Abrir factura PDF" href={adminInvoicePdfHref(invoice.id)}>
                          <ExternalLink size={16} />
                        </IconLink>
                        <IconLink label="Descargar PDF" href={adminInvoicePdfHref(invoice.id, true)}>
                          <Download size={16} />
                        </IconLink>
                        {canCancelInvoices ? (
                          <IconButton
                            label="Anular factura"
                            onClick={() => cancelInvoice(invoice)}
                            disabled={isPending || invoice.status === "anulada"}
                          >
                            <Ban size={16} />
                          </IconButton>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedInvoice ? (
        <InvoiceModal
          invoice={selectedInvoice}
          canCorrectInvoices={canCorrectInvoices}
          isPending={isPending}
          onCorrect={correctInvoiceCustomerData}
          onPrint={() => printInvoice(selectedInvoice)}
          onClose={() => setSelectedInvoice(null)}
        />
      ) : null}
      {invoiceToCancel ? (
        <CancelInvoiceModal
          invoice={invoiceToCancel}
          isPending={isPending}
          onCancel={cancelInvoiceWithReason}
          onClose={() => setInvoiceToCancel(null)}
        />
      ) : null}
    </div>
  );
}

function InvoiceModal({
  invoice,
  canCorrectInvoices,
  isPending,
  onCorrect,
  onPrint,
  onClose,
}: {
  invoice: AdminInvoiceDetail;
  canCorrectInvoices: boolean;
  isPending: boolean;
  onCorrect: (input: {
    invoiceId: string;
    customerName: string;
    customerRtn: string;
    customerPhone: string;
    customerEmail: string;
    customerAddress: string;
    correctionReason: string;
  }) => void;
  onPrint: () => void;
  onClose: () => void;
}) {
  const [customerName, setCustomerName] = useState(invoice.customer_name);
  const [customerRtn, setCustomerRtn] = useState(invoice.customer_rtn ?? "");
  const [customerPhone, setCustomerPhone] = useState(invoice.customer_phone ?? "");
  const [customerEmail, setCustomerEmail] = useState(invoice.customer_email ?? "");
  const [customerAddress, setCustomerAddress] = useState(invoice.customer_address ?? "");
  const [correctionReason, setCorrectionReason] = useState("");
  const [confirmingCorrection, setConfirmingCorrection] = useState(false);
  const normalizedRtn = customerRtn.trim().replace(/[\s-]/g, "");
  const rtnIsValid = normalizedRtn.length === 0 || /^\d{14}$/.test(normalizedRtn);
  const canSubmitCorrection = customerName.trim().length > 0 && correctionReason.trim().length >= 10 && rtnIsValid;
  const officialInvoice = adminInvoiceToOfficialInvoice(invoice);

  function submitCorrection() {
    onCorrect({
      invoiceId: invoice.id,
      customerName,
      customerRtn,
      customerPhone,
      customerEmail,
      customerAddress,
      correctionReason,
    });
    setConfirmingCorrection(false);
  }

  return (
    <div className="cz-layer-modal fixed inset-0 overflow-y-auto bg-black/45 p-3 sm:p-4">
      <section className="mx-auto my-4 max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg bg-white p-4 text-[#080808] sm:my-8 sm:p-5">
        <div className="flex flex-col gap-3 border-b border-black/10 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm text-black/50">{invoice.company_legal_name || "Car Zone Accesorios"}</p>
            <h2 className="break-words text-2xl font-semibold [overflow-wrap:anywhere]">{invoice.invoice_number}</h2>
            <p className="mt-1 break-words text-sm text-black/55 [overflow-wrap:anywhere]">CAI: {invoice.cai || "-"}</p>
          </div>
          <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-4">
            <a
              href={adminInvoicePdfHref(invoice.id)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-4 py-2 text-center text-sm font-semibold leading-snug text-[#080808] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:bg-[#fff1f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2"
            >
              <ExternalLink size={16} />
              Abrir factura
            </a>
            <a
              href={adminInvoicePdfHref(invoice.id, true)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center justify-center gap-2 rounded-md bg-[#080808] px-4 py-2 text-center text-sm font-semibold leading-snug text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#1f1f1f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2"
            >
              <FileText size={16} />
              Descargar PDF
            </a>
            <Button onClick={onPrint} variant="ghost" className="w-full">
              <Printer size={16} />
              Imprimir
            </Button>
            <Button onClick={onClose} variant="ghost" className="w-full">Cerrar</Button>
          </div>
        </div>
        <p className="mt-3 rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
          En celular, abre la factura y usa Compartir o Guardar PDF si la descarga no inicia automáticamente.
        </p>

        <section className="-mx-4 bg-[#d4d4d4] sm:-mx-5">
          <OfficialInvoiceDocument invoice={officialInvoice} />
        </section>

        <h3 className="mt-5 font-semibold">Datos internos y correcciones</h3>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <Info label="Número fiscal" value={invoice.invoice_number} />
          <Info label="CAI" value={invoice.cai ?? "-"} />
          <Info label="Rango autorizado desde" value={invoice.fiscal_range_start ?? "-"} />
          <Info label="Rango autorizado hasta" value={invoice.fiscal_range_end ?? "-"} />
          <Info label="Fecha de emisión" value={formatDate(invoice.cai_authorization_date)} />
          <Info label="Fecha de vencimiento" value={formatDate(invoice.due_at)} />
          <Info label="Fecha registrada" value={formatDate(invoice.issued_at ?? invoice.created_at)} />
          <Info label="Cliente" value={invoice.customer_name} />
          <Info label="RTN del cliente" value={invoice.customer_rtn ?? "-"} />
          <Info label="Correo electrónico" value={invoice.customer_email ?? "-"} />
          <Info label="Teléfono" value={invoice.customer_phone ?? "-"} />
          <Info label="Dirección" value={invoice.customer_address ?? "-"} />
          <Info label="Método de pago" value={paymentMethodLabel(invoice.payment_method, { detailedCard: true })} />
          <Info label="Referencia bancaria" value={invoice.bank_reference_number ?? "-"} />
          <Info label="Estado del pago" value={invoice.payment_status ?? "-"} />
          <div className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
            <p className="text-sm text-black/50">Comprobante interno</p>
            {invoice.transfer_receipt_url ? (
              <a
                href={invoice.transfer_receipt_url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium"
              >
                <ExternalLink size={16} />
                Ver comprobante
              </a>
            ) : (
              <p className="mt-1 font-semibold">-</p>
            )}
          </div>
          <Info label="Estado" value={statusLabels[invoice.status]} />
          <Info label="Fecha" value={formatDate(invoice.issued_at ?? invoice.created_at)} />
        </div>

        <div className="mt-5">
          <AccountingTraceabilityCard traceability={invoice.accounting_traceability} />
        </div>

        {canCorrectInvoices && invoice.status !== "anulada" && invoice.status !== "cancelled" ? (
          <section className="mt-5 rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
            <h3 className="flex items-center gap-2 font-semibold">
              <FilePenLine size={18} />
              Corregir datos fiscales
            </h3>
            <p className="mt-1 text-sm text-black/55">
              No cambia número fiscal, CAI, rango, fecha original, productos ni totales.
            </p>
            <p className="mt-2 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">{fiscalCorrectionWarning}</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Cliente / razón social</span>
                <Input value={customerName} onChange={(event) => setCustomerName(event.target.value)} />
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">RTN</span>
                <Input value={customerRtn} onChange={(event) => setCustomerRtn(event.target.value)} placeholder="14 dígitos o vacío" />
                {!rtnIsValid ? <p className="mt-1 text-xs font-medium text-[#b91c25]">El RTN debe contener 14 dígitos.</p> : null}
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Teléfono</span>
                <Input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} />
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Correo electrónico</span>
                <Input value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} />
              </label>
              <label className="md:col-span-2">
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Dirección</span>
                <Input value={customerAddress} onChange={(event) => setCustomerAddress(event.target.value)} />
              </label>
              <label className="md:col-span-2">
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Motivo de corrección</span>
                <textarea
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  className="min-h-24 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                  placeholder="Ej. El cliente solicito corregir RTN."
                />
              </label>
            </div>
            {confirmingCorrection ? (
              <div className="mt-4 rounded-md border border-[#f59e0b]/35 bg-[#fffbeb] p-4 text-sm text-[#7c2d12]">
                <p>{fiscalCorrectionWarning}</p>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                  <Button onClick={() => setConfirmingCorrection(false)} variant="ghost">
                    Cancelar
                  </Button>
                  <Button onClick={submitCorrection} disabled={isPending || !canSubmitCorrection} variant="primary">
                    Guardar corrección
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="mt-4 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-end">
              <Button onClick={onClose} variant="ghost">Cancelar</Button>
              <Button
                onClick={() => setConfirmingCorrection(true)}
                disabled={isPending || !canSubmitCorrection}
                variant="primary"
              >
                {isPending ? "Guardando..." : "Guardar corrección"}
              </Button>
            </div>
          </section>
        ) : invoice.status === "anulada" || invoice.status === "cancelled" ? (
          <p className="mt-5 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
            No se pueden corregir datos de una factura anulada.
          </p>
        ) : null}

        {canCorrectInvoices ? <FiscalCorrectionHistory history={invoice.fiscal_correction_history} /> : null}

        <div className="mt-5 overflow-hidden rounded-lg border border-black/10">
          <div className="grid gap-3 p-3 md:hidden">
            {invoice.items.map((item) => (
              <InvoiceItemCard key={`${item.id}-card`} item={item} />
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">SKU</th>
                <th className="px-4 py-3">Producto</th>
                <th className="px-4 py-3">Cantidad</th>
                <th className="px-4 py-3">Precio</th>
                <th className="px-4 py-3">Subtotal de línea</th>
                <th className="px-4 py-3">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {invoice.items.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3 break-words [overflow-wrap:anywhere]">{item.sku}</td>
                  <td className="px-4 py-3 break-words [overflow-wrap:anywhere]">{item.product_name}</td>
                  <td className="px-4 py-3">{item.quantity}</td>
                  <td className="px-4 py-3">{formatCurrency(item.unit_price)}</td>
                  <td className="px-4 py-3">{formatCurrency(item.line_total)}</td>
                  <td className="px-4 py-3">{formatCurrency(item.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>

        <p className="mt-5 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
          Validar tratamiento fiscal de envío y comisión con la contadora.
        </p>

        <div className="mt-5 grid gap-2 text-sm md:grid-cols-5">
          <p>Subtotal antes de ISV: {formatCurrency(invoice.subtotal)}</p>
          <p>ISV incluido 15%: {formatCurrency(invoice.tax)}</p>
          <p>Envío: {formatCurrency(invoice.shipping_fee)}</p>
          <p>Comisión: {formatCurrency(invoice.cash_on_delivery_fee)}</p>
          <p>Recargo mínimo: {formatCurrency(invoice.small_order_fee)}</p>
          <p>Descuentos: {invoice.discount_total > 0 ? `-${formatCurrency(invoice.discount_total)}` : formatCurrency(0)}</p>
          <p>Otros cargos: {formatCurrency(invoice.additional_fees.reduce((sum, fee) => sum + fee.amount, 0))}</p>
          <p className="font-semibold">Total: {formatCurrency(invoice.total)}</p>
        </div>
      </section>
    </div>
  );
}

function InvoiceItemCard({ item }: { item: AdminInvoiceDetail["items"][number] }) {
  return (
    <div className="rounded-md border border-black/10 bg-[#f4f4f5] p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-semibold [overflow-wrap:anywhere]">{item.product_name}</p>
          <p className="mt-1 break-words text-xs text-black/55 [overflow-wrap:anywhere]">SKU: {item.sku}</p>
        </div>
        <span className="shrink-0 rounded-md bg-white px-2 py-1 text-xs font-semibold">x{item.quantity}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-black/65">
        <p>Precio: {formatCurrency(item.unit_price)}</p>
        <p className="text-right font-semibold text-black">Total: {formatCurrency(item.line_total)}</p>
      </div>
    </div>
  );
}

function printInvoiceDocument(invoice: AdminInvoiceDetail) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.srcdoc = buildOfficialInvoicePrintHtml(adminInvoiceToOfficialInvoice(invoice), { baseUrl: window.location.origin });
  document.body.appendChild(iframe);

  iframe.onload = () => {
    const printWindow = iframe.contentWindow;
    if (!printWindow) {
      iframe.remove();
      return;
    }

    printWindow.focus();
    printWindow.print();
    window.setTimeout(() => iframe.remove(), 1000);
  };
}

function CancelInvoiceModal({
  invoice,
  isPending,
  onCancel,
  onClose,
}: {
  invoice: AdminInvoiceRow;
  isPending: boolean;
  onCancel: (invoice: AdminInvoiceRow, cancellationReason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const canSubmit = reason.trim().length >= 8;

  return (
    <div className="cz-layer-modal fixed inset-0 overflow-y-auto bg-black/45 p-3 sm:p-4">
      <section className="mx-auto my-4 max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-4 text-[#080808] sm:my-10 sm:p-5">
        <div className="border-b border-black/10 pb-4">
          <p className="text-sm font-semibold text-[#9b341b]">Anular factura</p>
          <h2 className="mt-1 text-2xl font-semibold">{invoice.invoice_number}</h2>
          <p className="mt-2 text-sm text-black/60">
            Esta acción queda auditada y requiere motivo formal. No elimina la factura ni libera el correlativo fiscal.
          </p>
        </div>
        <p className="mt-4 rounded-md bg-[#fff7ed] p-3 text-sm font-medium text-[#7c2d12]">
          Esta acción será definitiva y quedará registrada en auditoría.
        </p>
        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium uppercase text-black/50">Motivo de anulación</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
          />
        </label>
        <div className="mt-5 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          <Button onClick={onClose} variant="ghost">Cerrar</Button>
          <Button onClick={() => onCancel(invoice, reason)} disabled={isPending || !canSubmit} variant="secondary">
            <Ban size={16} />
            Anular factura
          </Button>
        </div>
      </section>
    </div>
  );
}

function FiscalCorrectionHistory({ history }: { history: FiscalCorrectionHistoryEntry[] }) {
  return (
    <section className="mt-5 rounded-lg border border-black/10 bg-white p-4">
      <h3 className="font-semibold">Historial de correcciones fiscales</h3>
      {history.length === 0 ? (
        <p className="mt-2 text-sm text-black/55">Sin correcciones fiscales registradas.</p>
      ) : (
        <>
        <div className="mt-3 grid gap-2 md:hidden">
          {history.flatMap((entry) => {
            const fields =
              entry.fields_modified.length > 0
                ? entry.fields_modified
                : (Object.keys(entry.new_values) as FiscalCorrectionValueKey[]);
            return fields.map((field) => (
              <article key={`${entry.id}-${field}-mobile`} className="rounded-md border border-black/10 bg-white p-3 text-sm">
                <p className="text-xs text-black/50">{formatDate(entry.created_at)}</p>
                <p className="mt-1 font-semibold">{fiscalCorrectionFieldLabels[field] ?? field}</p>
                <p className="mt-1 text-black/60">{entry.user_label ?? "Usuario"}{entry.actor_role ? ` / ${entry.actor_role}` : ""}</p>
                <dl className="mt-3 grid gap-2">
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Anterior</dt>
                    <dd className="mt-1 break-words font-medium [overflow-wrap:anywhere]">{entry.old_values[field] || "-"}</dd>
                  </div>
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Nuevo</dt>
                    <dd className="mt-1 break-words font-medium [overflow-wrap:anywhere]">{entry.new_values[field] || "-"}</dd>
                  </div>
                </dl>
                <p className="mt-2 break-words text-black/60 [overflow-wrap:anywhere]">{entry.correction_reason ?? "-"}</p>
              </article>
            ));
          })}
        </div>
        <div className="mt-3 hidden overflow-x-auto md:block">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-3 py-2">Fecha</th>
                <th className="px-3 py-2">Usuario</th>
                <th className="px-3 py-2">Campo</th>
                <th className="px-3 py-2">Valor anterior</th>
                <th className="px-3 py-2">Valor nuevo</th>
                <th className="px-3 py-2">Motivo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {history.flatMap((entry) => {
                const fields =
                  entry.fields_modified.length > 0
                    ? entry.fields_modified
                    : (Object.keys(entry.new_values) as FiscalCorrectionValueKey[]);
                return fields.map((field) => (
                  <tr key={`${entry.id}-${field}`}>
                    <td className="px-3 py-2">{formatDate(entry.created_at)}</td>
                    <td className="px-3 py-2">
                      {entry.user_label ?? "Usuario"}
                      {entry.actor_role ? <span className="block text-xs text-black/45">{entry.actor_role}</span> : null}
                    </td>
                    <td className="px-3 py-2">{fiscalCorrectionFieldLabels[field] ?? field}</td>
                    <td className="px-3 py-2">{entry.old_values[field] || "-"}</td>
                    <td className="px-3 py-2">{entry.new_values[field] || "-"}</td>
                    <td className="px-3 py-2">{entry.correction_reason ?? "-"}</td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 break-words font-semibold [overflow-wrap:anywhere]">{value}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function StatusGuide({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4">
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-xs leading-5 text-black/55">{detail}</p>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={disabled}
      className="grid size-9 place-items-center rounded-md border border-black/10 bg-white transition-colors hover:bg-[#f4f4f5] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function IconLink({
  label,
  href,
  children,
}: {
  label: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={label}
      aria-label={label}
      className="grid size-9 place-items-center rounded-md border border-black/10 bg-white transition-colors hover:bg-[#f4f4f5]"
    >
      {children}
    </a>
  );
}


