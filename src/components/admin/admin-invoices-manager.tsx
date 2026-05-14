"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Download, ExternalLink, Eye, FileText, Printer } from "lucide-react";
import { cancelInvoiceAction, logInvoiceReprintAction, updateInvoiceCustomerDataAction } from "@/app/admin/facturas/actions";
import { FiscalAlertsPanel } from "@/components/admin/fiscal-alerts-panel";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { FiscalAlert, FiscalSettings } from "@/types/fiscal";
import type { AdminInvoiceRow, InvoiceStatus } from "@/types/invoices";
import { formatHnDate } from "@/utils/format";
import { createPdfDocument, getLastAutoTableY } from "@/utils/pdf-client";
import { formatCurrency } from "@/utils/pricing";

type AdminInvoicesManagerProps = {
  invoices: AdminInvoiceRow[];
  total: number;
  page: number;
  pageSize: number;
  fiscalSettings: FiscalSettings;
  fiscalAlerts: FiscalAlert[];
  canCancelInvoices: boolean;
  canCorrectInvoices: boolean;
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

const paymentLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
};

function formatDate(value: string | null) {
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

export function AdminInvoicesManager({
  invoices,
  total,
  page,
  pageSize,
  fiscalSettings,
  fiscalAlerts,
  canCancelInvoices,
  canCorrectInvoices,
}: AdminInvoicesManagerProps) {
  const router = useRouter();
  const [status, setStatus] = useState<InvoiceStatus | "all">("all");
  const [paymentMethod, setPaymentMethod] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState<AdminInvoiceRow | null>(null);
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

  function exportCsv() {
    const columns = [
      "Factura",
      "Cliente",
      "RTN cliente",
      "Fecha",
      "Método de pago",
      "Referencia bancaria",
      "Subtotal",
      "ISV",
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
      paymentLabels[invoice.payment_method] ?? invoice.payment_method,
      invoice.bank_reference_number ?? "-",
      invoice.subtotal,
      invoice.tax,
      invoice.shipping_fee,
      invoice.cash_on_delivery_fee,
      invoice.total,
      statusLabels[invoice.status],
    ]);

    downloadBlob(
      [columns.map(csvEscape).join(","), ...rows.map((row) => row.map(csvEscape).join(","))].join("\n"),
      "car-zone-facturas.csv",
      "text/csv;charset=utf-8",
    );
  }

  async function exportInvoicePdf(invoice: AdminInvoiceRow) {
    const { doc, autoTable } = await createPdfDocument();
    doc.setFontSize(14);
    doc.text(fiscalSettings.legal_name || "Car Zone Accesorios", 14, 16);
    doc.setFontSize(9);
    doc.text(`RTN: ${fiscalSettings.rtn || invoice.rtn || "-"}`, 14, 23);
    doc.text(`CAI: ${fiscalSettings.cai || invoice.cai || "-"}`, 14, 29);
    doc.text(`Factura: ${invoice.invoice_number}`, 140, 16);
    doc.text(`Fecha: ${formatDate(invoice.issued_at ?? invoice.created_at)}`, 140, 23);
    doc.text(`Cliente: ${invoice.customer_name}`, 14, 42);
    doc.text(`RTN cliente: ${invoice.customer_rtn ?? "-"}`, 14, 48);
    doc.text(`Teléfono: ${invoice.customer_phone ?? "-"}`, 14, 54);
    doc.text(`Dirección: ${invoice.customer_address ?? "-"}`, 14, 60);
    doc.text(`Pago: ${paymentLabels[invoice.payment_method] ?? invoice.payment_method}`, 14, 66);
    if (invoice.bank_reference_number) {
      doc.text(`Referencia bancaria: ${invoice.bank_reference_number}`, 14, 72);
    }
    if (invoice.transfer_receipt_url) {
      doc.text("Comprobante transferencia: disponible como referencia interna", 14, invoice.bank_reference_number ? 78 : 72);
    }
    autoTable(doc, {
      startY: invoice.transfer_receipt_url ? (invoice.bank_reference_number ? 86 : 80) : invoice.bank_reference_number ? 80 : 74,
      head: [["SKU", "Producto", "Cantidad", "Precio", "Total"]],
      body: invoice.items.map((item) => [
        item.sku,
        item.product_name,
        item.quantity,
        formatCurrency(item.unit_price),
        formatCurrency(item.line_total),
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [228, 37, 44] },
    });
    const finalY = getLastAutoTableY(doc);
    doc.text(`Subtotal: ${formatCurrency(invoice.subtotal)}`, 140, finalY + 10);
    doc.text(`ISV: ${formatCurrency(invoice.tax)}`, 140, finalY + 16);
    doc.text(`Envío: ${formatCurrency(invoice.shipping_fee)}`, 140, finalY + 22);
    doc.text(`Comisión entrega: ${formatCurrency(invoice.cash_on_delivery_fee)}`, 140, finalY + 28);
    doc.text(`Total: ${formatCurrency(invoice.total)}`, 140, finalY + 34);
    doc.text("Validar tratamiento fiscal de envío y comisión con la contadora.", 14, finalY + 34);
    doc.save(`${invoice.invoice_number}.pdf`);
  }

  function reprintInvoice(invoice: AdminInvoiceRow) {
    startTransition(async () => {
      const result = await logInvoiceReprintAction(invoice.id);
      if (!result.ok) {
        showInvoiceMessage(result.message, false);
        return;
      }

      await exportInvoicePdf(invoice);
      showInvoiceMessage(result.message || "Factura reimpresa correctamente.", true);
      router.refresh();
    });
  }

  async function cancelInvoice(invoice: AdminInvoiceRow) {
    const confirmed = await toast.confirm({
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

  function correctInvoiceCustomerData(input: {
    invoiceId: string;
    customerName: string;
    customerRtn: string;
    customerPhone: string;
    customerAddress: string;
  }) {
    startTransition(async () => {
      const result = await updateInvoiceCustomerDataAction(input);
      showInvoiceMessage(result.message, result.ok);
      if (result.ok) {
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-5">
      <FiscalAlertsPanel alerts={fiscalAlerts} />

      <PaginationControls basePath="/admin/facturas" page={page} pageSize={pageSize} total={total} label="facturas" />

      <div className="grid gap-3 md:grid-cols-3">
        <Metric label="Subtotal" value={formatCurrency(totals.subtotal)} />
        <Metric label="ISV" value={formatCurrency(totals.tax)} />
        <Metric label="Total facturado" value={formatCurrency(totals.total)} />
      </div>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_180px_220px_auto] lg:items-end">
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
              <option value="card">Tarjeta</option>
              <option value="cash">Efectivo</option>
            </select>
          </label>
          <Button onClick={exportCsv} variant="ghost">
            <Download size={16} />
            CSV
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
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">Factura</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">RTN cliente</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Método de pago</th>
                <th className="px-4 py-3">Referencia bancaria</th>
                <th className="px-4 py-3">Subtotal</th>
                <th className="px-4 py-3">ISV</th>
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
                    No hay facturas para mostrar.
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="px-4 py-3 font-semibold">{invoice.invoice_number}</td>
                    <td className="px-4 py-3">{invoice.customer_name}</td>
                    <td className="px-4 py-3">{invoice.customer_rtn ?? "-"}</td>
                    <td className="px-4 py-3">{formatDate(invoice.issued_at ?? invoice.created_at)}</td>
                    <td className="px-4 py-3">{paymentLabels[invoice.payment_method] ?? invoice.payment_method}</td>
                    <td className="px-4 py-3">{invoice.bank_reference_number ?? "-"}</td>
                    <td className="px-4 py-3">{formatCurrency(invoice.subtotal)}</td>
                    <td className="px-4 py-3">{formatCurrency(invoice.tax)}</td>
                    <td className="px-4 py-3">{formatCurrency(invoice.shipping_fee)}</td>
                    <td className="px-4 py-3">{formatCurrency(invoice.cash_on_delivery_fee)}</td>
                    <td className="px-4 py-3 font-semibold">{formatCurrency(invoice.total)}</td>
                    <td className="px-4 py-3">{statusLabels[invoice.status]}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <IconButton label="Ver factura" onClick={() => setSelectedInvoice(invoice)}>
                          <Eye size={16} />
                        </IconButton>
        <IconButton label="Reimprimir factura" onClick={() => reprintInvoice(invoice)}>
                          <Printer size={16} />
                        </IconButton>
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
          fiscalSettings={fiscalSettings}
          canCorrectInvoices={canCorrectInvoices}
          isPending={isPending}
          onCorrect={correctInvoiceCustomerData}
          onReprint={() => reprintInvoice(selectedInvoice)}
          onClose={() => setSelectedInvoice(null)}
        />
      ) : null}
    </div>
  );
}

function InvoiceModal({
  invoice,
  fiscalSettings,
  canCorrectInvoices,
  isPending,
  onCorrect,
  onReprint,
  onClose,
}: {
  invoice: AdminInvoiceRow;
  fiscalSettings: FiscalSettings;
  canCorrectInvoices: boolean;
  isPending: boolean;
  onCorrect: (input: {
    invoiceId: string;
    customerName: string;
    customerRtn: string;
    customerPhone: string;
    customerAddress: string;
  }) => void;
  onReprint: () => void;
  onClose: () => void;
}) {
  const [customerName, setCustomerName] = useState(invoice.customer_name);
  const [customerRtn, setCustomerRtn] = useState(invoice.customer_rtn ?? "");
  const [customerPhone, setCustomerPhone] = useState(invoice.customer_phone ?? "");
  const [customerAddress, setCustomerAddress] = useState(invoice.customer_address ?? "");

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/45 p-4">
      <section className="mx-auto my-8 max-w-4xl rounded-lg bg-white p-5 text-[#080808]">
        <div className="flex items-start justify-between gap-3 border-b border-black/10 pb-4">
          <div>
            <p className="text-sm text-black/50">{fiscalSettings.legal_name || "Car Zone Accesorios"}</p>
            <h2 className="text-2xl font-semibold">{invoice.invoice_number}</h2>
            <p className="mt-1 text-sm text-black/55">CAI: {fiscalSettings.cai || invoice.cai || "-"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onReprint} variant="dark">
              <Printer size={16} />
              Reimprimir factura
            </Button>
            <Button onClick={onClose} variant="ghost">Cerrar</Button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <Info label="Cliente" value={invoice.customer_name} />
          <Info label="RTN del cliente" value={invoice.customer_rtn ?? "-"} />
          <Info label="Teléfono" value={invoice.customer_phone ?? "-"} />
          <Info label="Dirección" value={invoice.customer_address ?? "-"} />
          <Info label="Método de pago" value={paymentLabels[invoice.payment_method] ?? invoice.payment_method} />
          <Info label="Referencia bancaria" value={invoice.bank_reference_number ?? "-"} />
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

        {canCorrectInvoices ? (
          <section className="mt-5 rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
            <h3 className="font-semibold">Corregir datos del cliente</h3>
            <p className="mt-1 text-sm text-black/55">
              No cambia número fiscal, CAI, rango, fecha original, productos ni totales.
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Nombre</span>
                <Input value={customerName} onChange={(event) => setCustomerName(event.target.value)} />
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">RTN</span>
                <Input value={customerRtn} onChange={(event) => setCustomerRtn(event.target.value)} />
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Teléfono</span>
                <Input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} />
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Dirección</span>
                <Input value={customerAddress} onChange={(event) => setCustomerAddress(event.target.value)} />
              </label>
            </div>
            <Button
              onClick={() =>
                onCorrect({
                  invoiceId: invoice.id,
                  customerName,
                  customerRtn,
                  customerPhone,
                  customerAddress,
                })
              }
              disabled={isPending}
              variant="primary"
              className="mt-4"
            >
              {isPending ? "Guardando..." : "Guardar corrección"}
            </Button>
          </section>
        ) : null}

        <div className="mt-5 overflow-hidden rounded-lg border border-black/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">SKU</th>
                <th className="px-4 py-3">Producto</th>
                <th className="px-4 py-3">Cantidad</th>
                <th className="px-4 py-3">Precio</th>
                <th className="px-4 py-3">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {invoice.items.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3">{item.sku}</td>
                  <td className="px-4 py-3">{item.product_name}</td>
                  <td className="px-4 py-3">{item.quantity}</td>
                  <td className="px-4 py-3">{formatCurrency(item.unit_price)}</td>
                  <td className="px-4 py-3">{formatCurrency(item.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-5 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
          Validar tratamiento fiscal de envío y comisión con la contadora.
        </p>

        <div className="mt-5 grid gap-2 text-sm md:grid-cols-5">
          <p>Subtotal: {formatCurrency(invoice.subtotal)}</p>
          <p>ISV: {formatCurrency(invoice.tax)}</p>
          <p>Envío: {formatCurrency(invoice.shipping_fee)}</p>
          <p>Comisión: {formatCurrency(invoice.cash_on_delivery_fee)}</p>
          <p className="font-semibold">Total: {formatCurrency(invoice.total)}</p>
        </div>
      </section>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
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


