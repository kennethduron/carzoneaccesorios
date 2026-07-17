"use client";

import Link from "next/link";
import { Building2, LogIn, UserPlus } from "lucide-react";
import { WholesaleAccountRequestCard } from "@/components/store/wholesale-account-request-card";
import { WholesaleProgramConditionsCard } from "@/components/store/wholesale-program-info";
import type { WholesaleAccessState } from "@/types/wholesale";

export function WholesaleRequestForm({ initialAccessState }: { initialAccessState: WholesaleAccessState }) {
  if (initialAccessState.kind !== "guest") {
    return <WholesaleAccountRequestCard initialState={initialAccessState} />;
  }

  return (
    <section id="mayoreo" className="rounded-lg border border-black/10 bg-white p-5">
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-[#fff1f2] text-[#b91c25]">
          <Building2 size={18} />
        </div>
        <div className="min-w-0">
          <h2 className="font-semibold">Solicitar cuenta mayorista</h2>
          <p className="mt-1 text-sm leading-6 text-black/60">
            Conoce las condiciones del programa y solicita acceso mayorista desde tu cuenta de Car Zone Accesorios.
          </p>
        </div>
      </div>

      <div className="mt-4">
        <WholesaleProgramConditionsCard />
      </div>

      <div className="mt-4 rounded-md border border-[#e4252c]/20 bg-[#fff1f2] p-4 text-sm text-[#7f1d1d]">
        <p className="leading-6">
          ¿Ya tienes una cuenta? Inicia sesión para solicitar acceso mayorista. Si aún no tienes una, créala en menos de un minuto.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Link
            href="/login?next=/contacto%23mayoreo"
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#080808] px-4 py-2.5 font-semibold text-white transition-colors hover:bg-black/80 sm:w-auto"
          >
            <LogIn size={16} />
            Iniciar sesión
          </Link>
          <Link
            href="/registro"
            className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-black/15 bg-white px-4 py-2.5 font-semibold text-[#080808] transition-colors hover:bg-[#f4f4f5] sm:w-auto"
          >
            <UserPlus size={16} />
            Crear cuenta
          </Link>
        </div>
      </div>
    </section>
  );
}
