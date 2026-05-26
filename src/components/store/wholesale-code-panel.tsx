"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CheckCircle2, Clock, LogIn, ShieldAlert, Store } from "lucide-react";
import { getWholesaleAccessStateAction } from "@/app/actions/wholesale";
import { usePriceMode } from "@/contexts/price-mode-context";
import type { WholesaleAccessState } from "@/types/wholesale";

const loadingState: WholesaleAccessState = {
  kind: "regular",
  title: "Revisando acceso mayorista",
  message: "Estamos validando el estado de tu cuenta.",
  canEnterCode: false,
  account: null,
  shouldShowApprovedNotice: false,
  firstPurchaseRequirement: null,
};

const stateIcon = {
  guest: Store,
  regular: Store,
  pending: Clock,
  approved: CheckCircle2,
  rejected: ShieldAlert,
  suspended: ShieldAlert,
} satisfies Record<WholesaleAccessState["kind"], typeof Store>;

export function WholesaleCodePanel() {
  const [accessState, setAccessState] = useState<WholesaleAccessState>(loadingState);
  const [accessReady, setAccessReady] = useState(false);
  const { wholesaleAccount, activateWholesaleMode, clearWholesaleMode } = usePriceMode();

  useEffect(() => {
    let active = true;

    getWholesaleAccessStateAction().then((state) => {
      if (!active) {
        return;
      }

      setAccessState(state);
      setAccessReady(true);

      if (state.account) {
        activateWholesaleMode(state.account);
      } else {
        clearWholesaleMode();
      }
    });

    return () => {
      active = false;
    };
  }, [activateWholesaleMode, clearWholesaleMode]);

  const Icon = stateIcon[accessState.kind];

  return (
    <section className="rounded-lg border border-black/10 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon size={18} />
        <h2 className="font-semibold">{accessState.title}</h2>
      </div>

      <p className="rounded-md bg-[#f4f4f5] px-3 py-2 text-sm text-black/60" aria-live="polite">
        {wholesaleAccount ? "Precio mayorista activo automáticamente." : accessState.message}
      </p>

      {wholesaleAccount ? (
        <div className="mt-3 rounded-md bg-[#fff1f2] p-3 text-sm text-[#b91c25]">
          <p className="font-medium">{wholesaleAccount.businessName}</p>
          <p>Tu cuenta aprobada habilita precios mayoristas en catálogo, carrito y checkout.</p>
        </div>
      ) : null}

      {accessReady && accessState.kind === "guest" ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 rounded-md bg-[#080808] px-4 py-2 text-sm font-medium text-white"
          >
            <LogIn size={16} />
            Iniciar sesión
          </Link>
          <Link
            href="/contacto#mayoreo"
            className="inline-flex items-center justify-center rounded-md border border-black/10 bg-white px-4 py-2 text-sm font-medium"
          >
            Solicitar mayoreo
          </Link>
        </div>
      ) : null}

      {accessReady && accessState.kind === "regular" ? (
        <Link
          href="/contacto#mayoreo"
          className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-[#080808] px-4 py-2 text-sm font-medium text-white"
        >
          Solicitar acceso mayorista
        </Link>
      ) : null}
    </section>
  );
}
