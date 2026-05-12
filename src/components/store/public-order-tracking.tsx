"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { getPublicOrderTrackingAction, type PublicTrackingOrder } from "@/app/rastreo/actions";
import { useToast } from "@/contexts/toast-context";
import { formatCurrency } from "@/utils/pricing";

const progressSteps = [
  { key: "recibido", label: "Pedido recibido" },
  { key: "pago_pendiente", label: "Pago pendiente" },
  { key: "pago_confirmado", label: "Pago confirmado" },
  { key: "preparacion", label: "En preparación" },
  { key: "empacado", label: "Empacado" },
  { key: "enviado", label: "Enviado" },
  { key: "en_ruta", label: "En ruta" },
  { key: "entregado", label: "Entregado" },
];

const orderStatusLabels: Record<string, string> = {
  recibido: "Recibido",
  confirmado: "Confirmado",
  preparacion: "En preparación",
  empacado: "Empacado",
  enviado: "Enviado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
  pending: "Recibido",
  confirmed: "Confirmado",
  paid: "Pago confirmado",
  preparing: "En preparación",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

const paymentStatusLabels: Record<string, string> = {
  pending: "Pendiente",
  approved: "Confirmado",
  rejected: "Rechazado",
  refunded: "Reembolsado",
};

const paymentMethodLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
};

function activeProgressIndex(order: PublicTrackingOrder) {
  if (order.orderStatus === "cancelado" || order.orderStatus === "cancelled") {
    return 0;
  }

  if (order.orderStatus === "entregado" || order.orderStatus === "delivered") {
    return 7;
  }

  if (order.orderStatus === "en_ruta") {
    return 6;
  }

  if (order.orderStatus === "enviado" || order.orderStatus === "shipped") {
    return 5;
  }

  if (order.orderStatus === "empacado") {
    return 4;
  }

  if (order.orderStatus === "preparacion" || order.orderStatus === "preparing") {
    return 3;
  }

  if (order.paymentStatus === "approved" || order.orderStatus === "paid") {
    return 2;
  }

  return 1;
}

export function PublicOrderTracking({ initialCode = "" }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode);
  const [order, setOrder] = useState<PublicTrackingOrder | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  const progressIndex = useMemo(() => (order ? activeProgressIndex(order) : -1), [order]);

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
    // Solo debe buscar automaticamente al cargar con codigo en URL.
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
            className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#246a73]"
          />
        </label>
        <button
          disabled={isPending}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#246a73] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
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
            <InfoBlock label="Estado del pedido" value={orderStatusLabels[order.orderStatus] ?? order.orderStatus} />
            <InfoBlock label="Estado del pago" value={paymentStatusLabels[order.paymentStatus] ?? order.paymentStatus} />
          </div>

          <div className="mt-5 space-y-3">
            {progressSteps.map((step, index) => (
              <div key={step.key} className="flex items-center gap-3">
                <span className={`size-3 rounded-full ${index <= progressIndex ? "bg-[#246a73]" : "bg-black/15"}`} />
                <span className={index <= progressIndex ? "font-medium" : "text-black/45"}>{step.label}</span>
              </div>
            ))}
          </div>

          <div className="mt-5 overflow-hidden rounded-lg border border-black/10">
            <div className="bg-[#f0ede2] px-4 py-3 text-sm font-semibold">Productos comprados</div>
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
    <div className="rounded-lg border border-black/10 bg-[#f7f7f2] p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  );
}
