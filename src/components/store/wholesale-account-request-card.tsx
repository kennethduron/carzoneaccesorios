"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { CheckCircle2, Clock, Loader2, Send, ShieldAlert, Store, X } from "lucide-react";
import { submitRegisteredWholesaleRequestAction } from "@/app/actions/wholesale";
import { WholesaleProgramConditionsCard, WholesaleRequirementSummary } from "@/components/store/wholesale-program-info";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { WholesaleAccessState } from "@/types/wholesale";

type WholesaleAccountRequestCardProps = {
  initialState: WholesaleAccessState;
  context?: "contact" | "account";
};

const contactStatusCopy = {
  regular: {
    title: "Solicitar acceso mayorista",
    message: "Usaremos los datos de tu cuenta para revisar tu solicitud.",
    Icon: Store,
  },
  pending: {
    title: "Tu solicitud mayorista está en revisión.",
    message: "Te notificaremos cuando sea aprobada.",
    Icon: Clock,
  },
  approved: {
    title: "Ya tienes acceso mayorista.",
    message: "Los precios mayoristas se aplicarán automáticamente cuando inicies sesión.",
    Icon: CheckCircle2,
  },
  rejected: {
    title: "Tu solicitud mayorista fue revisada.",
    message: "Puedes contactar al equipo para más información.",
    Icon: ShieldAlert,
  },
  suspended: {
    title: "Tu acceso mayorista está suspendido.",
    message: "Contacta al equipo para más información.",
    Icon: ShieldAlert,
  },
  guest: {
    title: "Acceso mayorista",
    message: "Inicia sesión para solicitar mayoreo con un solo clic.",
    Icon: Store,
  },
} satisfies Record<WholesaleAccessState["kind"], { title: string; message: string; Icon: typeof Store }>;

const accountStatusCopy = {
  regular: {
    title: "Acceso mayorista",
    message: "Aún no has solicitado acceso mayorista.",
    Icon: Store,
  },
  pending: {
    title: "Solicitud mayorista en revisión",
    message: "Nuestro equipo revisará tu cuenta y te notificará cuando sea aprobada.",
    Icon: Clock,
  },
  approved: {
    title: "Cuenta mayorista activa",
    message: "Ya tienes acceso a precios mayoristas. Los precios especiales se aplican automáticamente en el catálogo, carrito y checkout.",
    Icon: CheckCircle2,
  },
  rejected: {
    title: "Solicitud mayorista revisada",
    message: "Contacta al equipo para más información.",
    Icon: ShieldAlert,
  },
  suspended: {
    title: "Acceso mayorista suspendido",
    message: "Contacta al equipo para más información.",
    Icon: ShieldAlert,
  },
  guest: {
    title: "Acceso mayorista",
    message: "Inicia sesión para solicitar mayoreo con un solo clic.",
    Icon: Store,
  },
} satisfies Record<WholesaleAccessState["kind"], { title: string; message: string; Icon: typeof Store }>;

export function WholesaleAccountRequestCard({ initialState, context = "contact" }: WholesaleAccountRequestCardProps) {
  const [state, setState] = useState(initialState);
  const [successOpen, setSuccessOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  const copy = context === "account" ? accountStatusCopy[state.kind] : contactStatusCopy[state.kind];
  const Icon = copy.Icon;
  const isApprovedAccount = context === "account" && state.kind === "approved";
  const requirement = state.firstPurchaseRequirement ?? state.account?.firstPurchaseRequirement ?? null;
  const showPendingFirstPurchase = state.kind === "approved" && requirement && !requirement.completed && requirement.minimum > 0;

  function submitRequest() {
    startTransition(async () => {
      const result = await submitRegisteredWholesaleRequestAction();

      if (result.state) {
        setState(result.state);
      }

      if (result.ok) {
        toast.notify({
          title: "Solicitud mayorista enviada",
          message: result.message,
          type: "success",
          duration: 7000,
        });
        setSuccessOpen(true);
      } else {
        toast.info(result.message);
      }
    });
  }

  return (
    <section
      id="mayoreo"
      className={`rounded-lg border p-5 shadow-sm ${
        isApprovedAccount ? "border-[#16a34a]/25 bg-[#f0fdf4]" : "border-black/10 bg-white"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`grid size-10 shrink-0 place-items-center rounded-md ${
            isApprovedAccount ? "bg-white text-[#166534]" : "bg-[#fff1f2] text-[#b91c25]"
          }`}
        >
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{copy.title}</h2>
          <p className="mt-1 text-sm leading-6 text-black/60">{state.kind === "approved" ? state.message : copy.message}</p>

          {state.kind === "approved" && state.account ? (
            <div className="mt-3 rounded-md bg-[#fff1f2] px-3 py-2 text-sm font-medium text-[#b91c25]">
              <p>Cuenta aprobada: {state.account.businessName}</p>
              <p className="mt-1 text-xs">{state.account.customerType === "existing" ? "Mayorista existente" : "Mayorista nuevo"}</p>
            </div>
          ) : null}

          {showPendingFirstPurchase && requirement ? (
            <div className="mt-3">
              <WholesaleRequirementSummary requirement={requirement} />
              {context === "account" ? (
                <Link
                  href="/catalogo"
                  className="mt-3 inline-flex rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white"
                >
                  Comprar ahora
                </Link>
              ) : null}
            </div>
          ) : null}

          {state.kind !== "approved" ? (
            <div className="mt-4">
              <WholesaleProgramConditionsCard compact />
            </div>
          ) : null}

          {state.kind === "regular" ? (
            <Button type="button" variant="dark" disabled={isPending} onClick={submitRequest} className="mt-4">
              {isPending ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}
              {isPending ? "Enviando solicitud..." : "Solicitar acceso mayorista"}
            </Button>
          ) : null}
        </div>
      </div>

      {successOpen ? (
        <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/45 px-4">
          <section className="w-full max-w-md rounded-lg bg-white p-5 text-[#080808] shadow-xl">
            <div className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-md bg-[#fff1f2] text-[#b91c25]">
                <CheckCircle2 size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold">Solicitud mayorista enviada</h2>
                <p className="mt-2 text-sm leading-6 text-black/65">
                  Recibimos tu solicitud. Nuestro equipo revisara tu cuenta y te notificaremos cuando tengas acceso a precios mayoristas.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSuccessOpen(false)}
                className="grid size-8 shrink-0 place-items-center rounded-md text-black/45 hover:bg-black/5"
                aria-label="Cerrar aviso"
              >
                <X size={16} />
              </button>
            </div>
            <div className="mt-5 flex justify-end">
              <Button type="button" variant="dark" onClick={() => setSuccessOpen(false)}>
                Entendido
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
