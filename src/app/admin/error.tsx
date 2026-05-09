"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui";

export default function AdminError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="grid min-h-screen place-items-center bg-[#f7f7f2] px-5 text-[#1c1d1b]">
      <div className="w-full max-w-xl rounded-lg border border-black/10 bg-white p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-1 text-[#9b341b]" size={24} />
          <div>
            <h1 className="text-xl font-semibold">Error en el panel administrativo</h1>
            <p className="mt-2 text-sm text-black/60">
              La accion se detuvo de forma segura. Reintenta o revisa la configuracion de Supabase si el problema continua.
            </p>
          </div>
        </div>
        <Button onClick={reset} variant="dark" className="mt-5">
          <RotateCcw size={17} />
          Reintentar
        </Button>
      </div>
    </section>
  );
}
