import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock, XCircle } from "lucide-react";
import { PublicStoreShell } from "@/components/store/public-store-shell";

type PaymentResultStatus = "approved" | "rejected" | "cancelled" | "pending";

const resultConfig: Record<
  PaymentResultStatus,
  {
    eyebrow: string;
    title: string;
    message: string;
    tone: string;
    icon: ReactNode;
  }
> = {
  approved: {
    eyebrow: "Pago aprobado",
    title: "Tu pago fue aprobado correctamente.",
    message: "Gracias por tu compra. Nuestro equipo continuará con la preparación y entrega del pedido.",
    tone: "bg-[#f0fdf4] text-[#166534]",
    icon: <CheckCircle2 size={30} />,
  },
  rejected: {
    eyebrow: "Pago rechazado",
    title: "No pudimos procesar tu pago. Intenta nuevamente o usa otro método.",
    message: "Si el problema continúa, comunícate con servicio al cliente para revisar tu pedido.",
    tone: "bg-[#fff0ea] text-[#9b341b]",
    icon: <XCircle size={30} />,
  },
  cancelled: {
    eyebrow: "Pago cancelado",
    title: "El pago fue cancelado. Tu pedido no fue confirmado.",
    message: "Puedes regresar al carrito o contactar a nuestro equipo si necesitas ayuda para completar la compra.",
    tone: "bg-[#f4f4f5] text-[#3f3f46]",
    icon: <AlertTriangle size={30} />,
  },
  pending: {
    eyebrow: "Pago pendiente",
    title: "Tu pago está pendiente de confirmación.",
    message: "Te notificaremos cuando la entidad bancaria confirme el resultado de la transacción.",
    tone: "bg-[#fff7ed] text-[#9b341b]",
    icon: <Clock size={30} />,
  },
};

export function PaymentResultPage({ status }: { status: PaymentResultStatus }) {
  const config = resultConfig[status];

  return (
    <PublicStoreShell>
      <section className="mx-auto flex min-h-[60vh] max-w-3xl items-center px-5 py-12">
        <div className="w-full rounded-lg border border-black/10 bg-white p-6 text-center shadow-sm">
          <div className={`mx-auto grid size-16 place-items-center rounded-full ${config.tone}`}>{config.icon}</div>
          <p className="mt-5 text-sm text-black/50">{config.eyebrow}</p>
          <h1 className="mt-2 text-3xl font-semibold">{config.title}</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-black/60">{config.message}</p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/rastreo" className="rounded-md bg-[#e4252c] px-4 py-3 text-sm font-semibold text-white">
              Rastrear pedido
            </Link>
            <Link href="/contacto-servicio-cliente" className="rounded-md border border-black/10 px-4 py-3 text-sm font-semibold">
              Servicio al cliente
            </Link>
          </div>
        </div>
      </section>
    </PublicStoreShell>
  );
}
