"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { getPublicOrderTrackingAction, type PublicTrackingOrder } from "@/app/rastreo/actions";
import { useToast } from "@/contexts/toast-context";
import { cashOnDeliveryApplies, isCashOnDeliveryPending } from "@/utils/cash-on-delivery";
import { canonicalOrderStatus, isPaymentConfirmed } from "@/utils/order-workflow";
import { formatCurrency } from "@/utils/pricing";

const cashProgressSteps = [
  { key: "recibido", label: "Pedido recibido" },
  { key: "pendiente_confirmacion", label: "Pendiente de confirmación" },
  { key: "aceptado", label: "Pedido aceptado" },
  { key: "preparacion", label: "En preparación" },
  { key: "empacado", label: "Empacado" },
  { key: "enviado", label: "Enviado" },
  { key: "en_ruta", label: "En ruta" },
  { key: "entregado", label: "Entregado" },
  { key: "pago_recibido", label: "Pago recibido" },
];

const transferProgressSteps = [
  { key: "recibido", label: "Pedido recibido" },
  { key: "revision", label: "Pago en revisión" },
  { key: "pago_confirmado", label: "Pago confirmado" },
  { key: "preparacion", label: "En preparación" },
  { key: "empacado", label: "Empacado" },
  { key: "enviado", label: "Enviado" },
  { key: "en_ruta", label: "En ruta" },
  { key: "entregado", label: "Entregado" },
];

const cardProgressSteps = [
  { key: "recibido", label: "Pedido recibido" },
  { key: "link_pago", label: "Link de pago por WhatsApp" },
  { key: "pago_aprobado", label: "Pago aprobado" },
  { key: "preparacion", label: "En preparación" },
  { key: "empacado", label: "Empacado" },
  { key: "enviado", label: "Enviado" },
  { key: "en_ruta", label: "En ruta" },
  { key: "entregado", label: "Entregado" },
];

const paymentMethodLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta por link de pago",
  cash: "Efectivo",
};

function trackingSteps(order: PublicTrackingOrder) {
  if (order.paymentMethod === "cash" || order.paymentTiming === "on_delivery") return cashProgressSteps;
  if (order.paymentMethod === "bank_transfer") return transferProgressSteps;
  return cardProgressSteps;
}

function customerOrderLabel(order: PublicTrackingOrder) {
  const status = canonicalOrderStatus(order.orderStatus);
  const labels: Record<string, string> = {
    recibido: "Pedido recibido",
    confirmado: "Pedido aceptado",
    preparacion: "En preparación",
    empacado: "Empacado",
    enviado: "Enviado",
    en_ruta: "En ruta",
    entregado: "Entregado",
    cancelado: "Pedido cancelado",
  };
  return labels[status] ?? order.orderStatus;
}

function customerPaymentLabel(order: PublicTrackingOrder) {
  if (order.paymentStatus === "rejected") return "Pago rechazado";
  if (isPaymentConfirmed(order.paymentStatus)) {
    if (order.paymentMethod === "cash") return "Pago recibido";
    if (order.paymentMethod === "card") return "Pago aprobado";
    return "Pago confirmado";
  }
  if (order.paymentMethod === "bank_transfer") {
    if (order.paymentTiming === "on_delivery") return "Pago pendiente al recibir";
    return "Pago en revisión";
  }
  if (order.paymentMethod === "card") return "Pago pendiente por link";
  return "Pendiente de confirmación";
}

function activeProgressIndex(order: PublicTrackingOrder) {
  const status = canonicalOrderStatus(order.orderStatus);
  if (status === "cancelado") return 0;

  if (order.paymentMethod === "cash" || order.paymentTiming === "on_delivery") {
    if (isPaymentConfirmed(order.paymentStatus) && status === "entregado") return 8;
    if (status === "entregado") return 7;
    if (status === "en_ruta") return 6;
    if (status === "enviado") return 5;
    if (status === "empacado") return 4;
    if (status === "preparacion") return 3;
    if (status === "confirmado") return 2;
    return 1;
  }

  if (order.paymentMethod === "bank_transfer") {
    if (status === "entregado") return 7;
    if (status === "en_ruta") return 6;
    if (status === "enviado") return 5;
    if (status === "empacado") return 4;
    if (status === "preparacion") return 3;
    if (isPaymentConfirmed(order.paymentStatus)) return 2;
    return 1;
  }

  if (status === "entregado") return 7;
  if (status === "en_ruta") return 6;
  if (status === "enviado") return 5;
  if (status === "empacado") return 4;
  if (status === "preparacion") return 3;
  if (isPaymentConfirmed(order.paymentStatus)) return 2;
  return 1;
}

export function PublicOrderTracking({ initialCode = "" }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode);
  const [order, setOrder] = useState<PublicTrackingOrder | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  const progressIndex = useMemo(() => (order ? activeProgressIndex(order) : -1), [order]);
  const progressSteps = useMemo(() => (order ? trackingSteps(order) : []), [order]);
  const orderIsCancelled = order ? canonicalOrderStatus(order.orderStatus) === "cancelado" : false;
  const cashOnDeliveryRequired = order ? cashOnDeliveryApplies(order.paymentMethod, order.paymentTiming) : false;
  const cashOnDeliveryPending = order ? isCashOnDeliveryPending(order.paymentMethod, order.paymentTiming, order.cashOnDeliveryFee) : false;

  function searchOrder(nextCode = code) {
    const normalizedCode = nextCode.trim().toUpperCase();
    if (!normalizedCode) {
      setMessage("Ingresa el código de seguimiento.");
      toast.warning("Ingresa el código de seguimiento.");
      return;
    }

    startTransition(async () => {
      const result = await getPublicOrderTrackingAction(normalizedCode);
      if (!result.ok) {
        setOrder(null);
        setMessage(result.message);
        toast.error(result.message);
        return;
      }

      setOrder(result.order);
      setMessage("");
      toast.success("Pedido encontrado.");
    });
  }

  useEffect(() => {
    if (initialCode) {
      const timeout = window.setTimeout(() => searchOrder(initialCode), 0);
      return () => window.clearTimeout(timeout);
    }
    return undefined;
    // Solo debe buscar automáticamente al cargar con código en URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  return (
    <div className="space-y-5">
      <form
        className="rounded-lg border border-black/10 bg-white p-5"
        onSubmit={(event) => {
          event.preventDefault();
          searchOrder();
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase text-black/50">Código de seguimiento</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Ej. TRK-CZ-8392-ABCD"
            className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
          />
        </label>
        <button
          disabled={isPending}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#e4252c] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
        >
          <Search size={17} />
          {isPending ? "Consultando..." : "Consultar pedido"}
        </button>
        {message ? <p className="mt-4 rounded-md bg-[#fff0ea] p-3 text-sm text-[#9b341b]">{message}</p> : null}
      </form>

      {order ? (
        <section className="rounded-lg border border-black/10 bg-white p-5">
          <div className="flex flex-col justify-between gap-3 border-b border-black/10 pb-4 sm:flex-row">
            <div>
              <p className="text-sm text-black/50">{new Date(order.createdAt).toLocaleString("es-HN")}</p>
              <h2 className="mt-1 text-2xl font-semibold">{order.orderNumber}</h2>
              <p className="mt-1 text-sm text-black/55">
                {order.customerNameMasked} / teléfono termina en {order.phoneLast4 || "----"}
              </p>
            </div>
            <div className="text-sm sm:text-right">
              <p className="font-semibold">{formatCurrency(order.total)}</p>
              <p className="text-black/55">{paymentMethodLabels[order.paymentMethod] ?? order.paymentMethod}</p>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <InfoBlock label="Estado del pedido" value={customerOrderLabel(order)} />
            <InfoBlock label="Estado del pago" value={customerPaymentLabel(order)} />
          </div>

          {cashOnDeliveryRequired ? (
            <p className="mt-5 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
              Contra entrega: {cashOnDeliveryPending ? "pendiente de confirmación" : formatCurrency(order.cashOnDeliveryFee)}.
              {cashOnDeliveryPending ? " El total mostrado es estimado y se actualizará cuando nuestro equipo confirme el cargo." : " El total mostrado ya incluye este cargo."}
            </p>
          ) : null}

          {order.paymentMethod === "bank_transfer" && order.paymentTiming === "before_delivery" && !isPaymentConfirmed(order.paymentStatus) ? (
            <div className="mt-5 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
              <p>
                {order.hasBankReference
                  ? "Pago en revisión. Estamos validando tu transferencia con la referencia proporcionada."
                  : "Pago en revisión. Contacta a servicio al cliente si no ingresaste referencia bancaria."}
              </p>
              <p className="mt-1">
                {order.hasTransferReceipt
                  ? "Comprobante recibido."
                  : "Comprobante no adjuntado. Revisaremos el pago con la referencia bancaria."}
              </p>
            </div>
          ) : null}

          {orderIsCancelled ? (
            <div className="mt-5 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
              Pedido cancelado. Los pasos futuros quedan desactivados.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {progressSteps.map((step, index) => (
                <div key={step.key} className="flex items-center gap-3">
                  <span className={`size-3 rounded-full ${index <= progressIndex ? "bg-[#e4252c]" : "bg-black/15"}`} />
                  <span className={index <= progressIndex ? "font-medium" : "text-black/45"}>{step.label}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-5 overflow-hidden rounded-lg border border-black/10">
            <div className="bg-[#e7e5e4] px-4 py-3 text-sm font-semibold">Productos comprados</div>
            <div className="divide-y divide-black/10">
              {order.items.map((item) => (
                <div key={`${item.sku}-${item.product_name}`} className="flex justify-between gap-3 p-4 text-sm">
                  <span>
                    {item.quantity} x {item.product_name}
                  </span>
                  <span>{formatCurrency(item.line_total)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  );
}
