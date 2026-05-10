"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ExternalLink, FileText, PackageCheck, Printer, XCircle } from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { generateInvoiceFromOrderAction } from "@/app/admin/pedidos/actions";
import { ContactActions } from "@/components/contact-actions";
import { Button } from "@/components/ui";
import type { FiscalSettings } from "@/types/fiscal";
import type { AdminOrderRow } from "@/types/orders";
import { formatCurrency } from "@/utils/pricing";

type AdminOrdersManagerProps = {
  orders: AdminOrderRow[];
  fiscalSettings: FiscalSettings;
  canManagePayments: boolean;
  canGenerateInvoices: boolean;
};

const orderStatusLabels: Record<string, string> = {
  recibido: "Recibido",
  confirmado: "Confirmado",
  preparacion: "Preparación",
  empacado: "Empacado",
  enviado: "Enviado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
  pending: "Pendiente",
  confirmed: "Confirmado",
  paid: "Pagado",
  preparing: "Preparación",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

const paymentStatusLabels: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobado",
  rejected: "Rechazado",
  refunded: "Reembolsado",
  pending_review: "Pendiente de revisión",
  confirmed: "Confirmado",
};

const paymentLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
};

export function AdminOrdersManager({
  orders,
  fiscalSettings,
  canManagePayments,
  canGenerateInvoices,
}: AdminOrdersManagerProps) {
  const router = useRouter();
  const [selectedOrderId, setSelectedOrderId] = useState(orders[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const selectedOrder = useMemo(
    () => orders.find((order) => order.id === selectedOrderId) ?? orders[0] ?? null,
    [orders, selectedOrderId],
  );

  function generateInvoice(order: AdminOrderRow) {
    startTransition(async () => {
      const result = await generateInvoiceFromOrderAction(order.id);
      setMessage(result.message);

      if (result.ok && result.invoiceNumber) {
        exportGeneratedInvoicePdf(order, fiscalSettings, result.invoiceNumber, result.bankReference ?? order.bank_reference_number);
        router.refresh();
      }
    });
  }

  if (orders.length === 0) {
    return (
      <section className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">
        No hay pedidos registrados en la base de datos.
      </section>
    );
  }

  return (
    <section className="grid gap-5 lg:grid-cols-[360px_1fr]">
      <div className="rounded-lg border border-black/10 bg-white">
        <div className="border-b border-black/10 p-4">
          <h2 className="font-semibold">Pedidos</h2>
          <p className="mt-1 text-sm text-black/55">{orders.length.toLocaleString("es-HN")} pedidos registrados</p>
        </div>
        <div className="divide-y divide-black/10">
          {orders.map((order) => (
            <button
              key={order.id}
              type="button"
              onClick={() => setSelectedOrderId(order.id)}
              className={`block w-full p-4 text-left transition-colors ${
                selectedOrder?.id === order.id ? "bg-[#e8f3f2]" : "bg-white hover:bg-[#f7f7f2]"
              }`}
            >
              <p className="font-semibold">{order.order_number}</p>
              <p className="mt-1 text-sm text-black/55">{order.customer_name}</p>
              <p className="mt-1 text-sm font-medium">{formatCurrency(order.total)}</p>
              {order.invoice_number ? (
                <p className="mt-1 text-xs font-medium text-[#1e5960]">Factura {order.invoice_number}</p>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {selectedOrder ? (
        <OrderDetail
          order={selectedOrder}
          fiscalSettings={fiscalSettings}
          canManagePayments={canManagePayments}
          canGenerateInvoices={canGenerateInvoices}
          isPending={isPending}
          message={message}
          onGenerateInvoice={() => generateInvoice(selectedOrder)}
        />
      ) : null}
    </section>
  );
}

function OrderDetail({
  order,
  fiscalSettings,
  canManagePayments,
  canGenerateInvoices,
  isPending,
  message,
  onGenerateInvoice,
}: {
  order: AdminOrderRow;
  fiscalSettings: FiscalSettings;
  canManagePayments: boolean;
  canGenerateInvoices: boolean;
  isPending: boolean;
  message: string;
  onGenerateInvoice: () => void;
}) {
  const isBankTransfer = order.payment_method === "bank_transfer";

  return (
    <article className="rounded-lg border border-black/10 bg-white p-5">
      <div className="flex flex-col justify-between gap-3 border-b border-black/10 pb-4 sm:flex-row sm:items-start">
        <div>
          <p className="text-sm text-black/50">{new Date(order.created_at).toLocaleString("es-HN")}</p>
          <h2 className="mt-1 flex items-center gap-2 text-2xl font-semibold">
            <PackageCheck size={22} />
            {order.order_number}
          </h2>
          <p className="mt-2 text-sm text-black/60">
            {order.customer_name} / {order.phone}
          </p>
          <ContactActions phone={order.phone} customerName={order.customer_name} className="mt-3" />
        </div>
        <span className="w-fit rounded-md bg-[#e8f3f2] px-3 py-2 text-sm font-medium text-[#1e5960]">
          {orderStatusLabels[order.status] ?? order.status}
        </span>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <InfoBlock label="Método de pago" value={paymentLabels[order.payment_method] ?? order.payment_method} />
        <InfoBlock label="Estado del pago" value={paymentStatusLabels[order.payment_status ?? "pending"] ?? "Pendiente"} />
        <InfoBlock label="Precio usado" value={order.price_mode === "wholesale" ? "Precio mayorista" : "Precio al detalle"} />
        <InfoBlock label="RTN del cliente" value={order.customer_rtn ?? "Sin RTN"} />
        {order.invoice_number ? <InfoBlock label="Factura fiscal" value={order.invoice_number} /> : null}
        {isBankTransfer ? (
          <>
            <InfoBlock label="Número de referencia" value={order.bank_reference_number ?? "Sin referencia"} />
            <div className="rounded-lg border border-black/10 bg-[#f7f7f2] p-4">
              <p className="text-sm text-black/50">Comprobante</p>
              {order.transfer_receipt_url ? (
                <a
                  href={order.transfer_receipt_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium"
                >
                  <ExternalLink size={16} />
                  Ver comprobante
                </a>
              ) : (
                <p className="mt-2 text-sm text-black/65">No fue subido.</p>
              )}
            </div>
          </>
        ) : null}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {canGenerateInvoices && !order.invoice_number ? (
          <Button onClick={onGenerateInvoice} disabled={isPending} variant="dark">
            <FileText size={17} />
            {isPending ? "Generando" : "Generar factura"}
          </Button>
        ) : null}
        {order.invoice_number ? (
          <Button
            onClick={() => exportGeneratedInvoicePdf(order, fiscalSettings, order.invoice_number ?? "", order.bank_reference_number)}
            variant="ghost"
          >
            <Printer size={17} />
            Descargar PDF
          </Button>
        ) : null}
        {canManagePayments ? (
          <>
            <Button disabled variant="primary">
              <CheckCircle2 size={17} />
              Confirmar pago
            </Button>
            <Button disabled variant="secondary">
              <XCircle size={17} />
              Rechazar pago
            </Button>
          </>
        ) : null}
      </div>
      {message ? <p className="mt-3 rounded-md bg-[#f7f7f2] p-3 text-sm text-black/60">{message}</p> : null}

      <div className="mt-5 overflow-hidden rounded-lg border border-black/10">
        <div className="bg-[#f0ede2] px-4 py-3 text-sm font-semibold">Productos</div>
        <div className="divide-y divide-black/10">
          {order.order_items.map((item) => (
            <div key={`${order.id}-${item.id}`} className="flex justify-between gap-3 p-4 text-sm">
              <span>
                {item.quantity} x {item.product_name}
                <span className="ml-2 text-black/45">({item.applied_price_mode === "wholesale" ? "mayorista" : "detalle"})</span>
              </span>
              <span className="font-medium">{formatCurrency(item.line_total)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-5 grid gap-2 text-sm md:grid-cols-3">
        <p>Subtotal: {formatCurrency(order.subtotal)}</p>
        <p>ISV: {formatCurrency(order.tax)}</p>
        <p className="font-semibold">Total: {formatCurrency(order.total)}</p>
      </div>
    </article>
  );
}

function exportGeneratedInvoicePdf(
  order: AdminOrderRow,
  fiscalSettings: FiscalSettings,
  invoiceNumber: string,
  bankReference: string | null,
) {
  const doc = new jsPDF();
  doc.setFontSize(14);
  doc.text(fiscalSettings.legal_name || "Car Zone Accesorios", 14, 16);
  doc.setFontSize(9);
  doc.text(`RTN: ${fiscalSettings.rtn || "-"}`, 14, 23);
  doc.text(`CAI: ${fiscalSettings.cai || "-"}`, 14, 29);
  doc.text(`Factura: ${invoiceNumber}`, 140, 16);
  doc.text(`Pedido: ${order.order_number}`, 140, 23);
  doc.text(`Fecha: ${new Date().toLocaleDateString("es-HN")}`, 140, 29);
  doc.text(`Cliente: ${order.customer_name}`, 14, 42);
  doc.text(`RTN cliente: ${order.customer_rtn ?? "-"}`, 14, 48);
  doc.text(`Teléfono: ${order.phone}`, 14, 54);
  doc.text(`Pago: ${paymentLabels[order.payment_method] ?? order.payment_method}`, 14, 60);
  doc.text(`Precio usado: ${order.price_mode === "wholesale" ? "precio mayorista" : "precio al detalle"}`, 14, 66);
  if (bankReference) {
    doc.text(`Referencia bancaria: ${bankReference}`, 14, 72);
  }

  autoTable(doc, {
    startY: bankReference ? 80 : 74,
    head: [["SKU", "Producto", "Cantidad", "Precio", "Total"]],
    body: order.order_items.map((item) => [
      item.sku,
      item.product_name,
      item.quantity,
      formatCurrency(item.unit_price),
      formatCurrency(item.line_total),
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [36, 106, 115] },
  });

  const finalY = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 90;
  doc.text(`Subtotal: ${formatCurrency(order.subtotal)}`, 140, finalY + 10);
  doc.text(`ISV: ${formatCurrency(order.tax)}`, 140, finalY + 16);
  doc.text(`Total: ${formatCurrency(order.total)}`, 140, finalY + 22);
  doc.save(`${invoiceNumber}.pdf`);
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-[#f7f7f2] p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  );
}
