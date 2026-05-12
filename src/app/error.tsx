"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { logGlobalErrorAction } from "@/app/error-actions";
import { Button } from "@/components/ui";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const pathname = usePathname();

  useEffect(() => {
    logGlobalErrorAction({
      route: pathname,
      message: error.message,
      stack: error.stack,
      digest: error.digest,
      name: error.name,
    }).catch((logError) => {
      console.error("No se pudo registrar el error global", logError);
    });
  }, [error, pathname]);

  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f7f2] px-5 text-[#1c1d1b]">
      <section className="w-full max-w-lg rounded-lg border border-black/10 bg-white p-6 text-center">
        <AlertTriangle className="mx-auto text-[#9b341b]" size={36} />
        <h1 className="mt-4 text-2xl font-semibold">No pudimos cargar esta vista</h1>
        <p className="mt-2 text-sm text-black/60">
          El sistema encontro un error controlado. Puedes reintentar sin perder la sesión.
        </p>
        <Button onClick={reset} variant="dark" className="mt-5">
          <RotateCcw size={17} />
          Reintentar
        </Button>
      </section>
    </main>
  );
}
