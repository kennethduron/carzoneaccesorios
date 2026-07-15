"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { logAdminErrorAction } from "@/app/admin/error-actions";
import { Button } from "@/components/ui";

type ErrorWithSupabaseDetails = Error & {
  digest?: string;
  code?: string;
  details?: string;
  hint?: string;
  status?: number | string;
};

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const pathname = usePathname();
  const isDevelopment = process.env.NODE_ENV === "development";
  const supabaseError = error as ErrorWithSupabaseDetails;

  useEffect(() => {
    logAdminErrorAction({
      route: pathname,
      action: "admin.error_boundary",
      message: error.message,
      stack: error.stack,
      digest: error.digest,
      name: error.name,
      supabaseError:
        supabaseError.code || supabaseError.details || supabaseError.hint || supabaseError.status
          ? {
              code: supabaseError.code ?? null,
              details: supabaseError.details ?? null,
              hint: supabaseError.hint ?? null,
              status: supabaseError.status ?? null,
            }
          : null,
    }).catch((logError) => {
      console.error("No se pudo registrar el error administrativo", logError);
    });
  }, [error, pathname, supabaseError.code, supabaseError.details, supabaseError.hint, supabaseError.status]);

  return (
    <section className="grid min-h-screen place-items-center bg-[#f4f4f5] px-5 text-[#080808]">
      <div className="w-full max-w-xl rounded-lg border border-black/10 bg-white p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-1 text-[#9b341b]" size={24} />
          <div>
            <h1 className="text-xl font-semibold">Error en el panel administrativo</h1>
            <p className="mt-2 text-sm text-black/60">
              {isDevelopment
                ? "La acción se detuvo. Abajo tienes el detalle técnico para depurar en desarrollo."
                : "No fue posible cargar esta sección. Reintenta y, si el problema continúa, contacta al equipo técnico."}
            </p>
          </div>
        </div>
        {isDevelopment ? (
          <div className="mt-5 space-y-3 rounded-md border border-[#9b341b]/20 bg-[#fff7ed] p-4 text-sm">
            <div>
              <p className="font-semibold text-[#7c2d12]">Ruta afectada</p>
              <p className="mt-1 break-words font-mono text-xs text-[#080808]">{pathname}</p>
            </div>
            <div>
              <p className="font-semibold text-[#7c2d12]">Mensaje real</p>
              <p className="mt-1 break-words font-mono text-xs text-[#080808]">{error.message || "Sin mensaje"}</p>
            </div>
            {error.digest ? (
              <div>
                <p className="font-semibold text-[#7c2d12]">Digest</p>
                <p className="mt-1 break-words font-mono text-xs text-[#080808]">{error.digest}</p>
              </div>
            ) : null}
            {error.stack ? (
              <div>
                <p className="font-semibold text-[#7c2d12]">Stack</p>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white/70 p-3 font-mono text-xs text-[#080808]">
                  {error.stack}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
        <Button onClick={reset} variant="dark" className="mt-5">
          <RotateCcw size={17} />
          Reintentar
        </Button>
      </div>
    </section>
  );
}



