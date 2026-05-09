"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, PackageCheck, XCircle } from "lucide-react";
import { ContactActionButtons } from "@/components/admin/contact-action-buttons";
import { Button } from "@/components/ui";
import { orderStatusLabels, useOrders } from "@/contexts/orders-context";
import type { PaymentReviewStatus, StoreOrder } from "@/types/orders";
import { formatCurrency } from "@/utils/pricing";

type AdminOrdersManagerProps = {
  canManagePayments: boolean;
};

const paymentStatusLabels: Record<PaymentReviewStatus, string> = {
  pending_review: "Pendiente de revisión",
  confirmed: "Confirmado",
  rejected: "Rechazado",
};

export function AdminOrdersManager({ canManagePayments }: AdminOrdersManagerProps) {
  const { orders, updatePaymentStatus } = useOrders();
  const [selectedOrderNumber, setSelectedOrderNumber] = useState(orders[0]?.orderNumber ?? "");

  const selectedOrder = useMemo(
    () => orders.find((order) => order.orderNumber === selectedOrderNumber) ?? orders[0] ?? null,
    [orders, selectedOrderNumber],
  );

  if (orders.length === 0) {
    return (
      <section className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">
        No hay pedidos registrados en esta sesión.
      </section>
    );
  }

  return (
    <section className="grid gap-5 lg:grid-cols-[360px_1fr]">
      <div className="rounded-lg border border-black/10 bg-white">
        <div className="border-b border-black/10 p-4">
          <h2 className="font-semibold">Pedidos</h2>
          <p className="mt-1 text-sm text-black/55">{orders.length.toLocaleString("es-HN")} pedidos en sesión</p>
        </div>
        <div className="divide-y divide-black/10">
          {orders.map((order) => (
            <button
              key={order.id}
              type="button"
              onClick={() => setSelectedOrderNumber(order.orderNumber)}
              className={`block w-full p-4 text-left transition-colors ${
                selectedOrder?.orderNumber === order.orderNumber ? "bg-[#e8f3f2]" : "bg-white hover:bg-[#f7f7f2]"
              }`}
            >
              <p className="font-semibold">{order.orderNumber}</p>
              <p className="mt-1 text-sm text-black/55">{order.customer.customerName}</p>
              <p className="mt-1 text-sm font-medium">{formatCurrency(order.total)}</p>
            </button>
          ))}
        </div>
      </div>

      {selectedOrder ? (
        <OrderDetail
          order={selectedOrder}
          canManagePayments={canManagePayments}
          onPaymentStatus={(status) => updatePaymentStatus(selectedOrder.orderNumber, status)}
        />
      ) : null}
    </section>
  );
}

function OrderDetail({
  order,
  canManagePayments,
  onPaymentStatus,
}: {
  order: StoreOrder;
  canManagePayments: boolean;
  onPaymentStatus: (status: PaymentReviewStatus) => void;
}) {
  const isBankTransfer = order.paymentMethod === "Transferencia bancaria";

  return (
    <article className="rounded-lg border border-black/10 bg-white p-5">
      <div className="flex flex-col justify-between gap-3 border-b border-black/10 pb-4 sm:flex-row sm:items-start">
        <div>
          <p className="text-sm text-black/50">{new Date(order.createdAt).toLocaleString("es-HN")}</p>
          <h2 className="mt-1 flex items-center gap-2 text-2xl font-semibold">
            <PackageCheck size={22} />
            {order.orderNumber}
          </h2>
          <p className="mt-2 text-sm text-black/60">
            {order.customer.customerName} / {order.phone}
          </p>
          <ContactActionButtons phone={order.phone} className="mt-3" />
        </div>
        <span className="w-fit rounded-md bg-[#e8f3f2] px-3 py-2 text-sm font-medium text-[#1e5960]">
          {orderStatusLabels[order.status]}
        </span>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <InfoBlock label="Método de pago" value={order.paymentMethod} />
        <InfoBlock label="Estado del pago" value={paymentStatusLabels[order.paymentStatus]} />
        {isBankTransfer ? (
          <>
            <InfoBlock label="Número de referencia" value={order.paymentReference ?? "Sin referencia"} />
            <div className="rounded-lg border border-black/10 bg-[#f7f7f2] p-4">
              <p className="text-sm text-black/50">Comprobante</p>
              {order.paymentProofFileName ? (
                <button
                  type="button"
                  className="mt-2 inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium"
                  title={order.paymentProofFileName}
                >
                  <ExternalLink size={16} />
                  Ver comprobante
                </button>
              ) : (
                <p className="mt-2 text-sm text-black/65">No fue subido.</p>
              )}
            </div>
          </>
        ) : null}
      </div>

      {canManagePayments ? (
        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={() => onPaymentStatus("confirmed")} variant="primary">
            <CheckCircle2 size={17} />
            Confirmar pago
          </Button>
          <Button onClick={() => onPaymentStatus("rejected")} variant="secondary">
            <XCircle size={17} />
            Rechazar pago
          </Button>
        </div>
      ) : (
        <p className="mt-5 rounded-md bg-[#f7f7f2] p-3 text-sm text-black/60">
          Tu rol puede consultar el pedido, pero no cambiar el estado del pago.
        </p>
      )}

      <div className="mt-5 overflow-hidden rounded-lg border border-black/10">
        <div className="bg-[#f0ede2] px-4 py-3 text-sm font-semibold">Productos</div>
        <div className="divide-y divide-black/10">
          {order.items.map((item) => (
            <div key={`${order.id}-${item.productId}`} className="flex justify-between gap-3 p-4 text-sm">
              <span>
                {item.quantity} x {item.name}
              </span>
              <span className="font-medium">{formatCurrency(item.lineTotal)}</span>
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

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-[#f7f7f2] p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  );
}
