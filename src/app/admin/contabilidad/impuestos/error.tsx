"use client";

export default function AccountingTaxReportError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="min-h-screen bg-[#f7f7f8] p-4 text-[#080808] sm:p-6">
      <section role="alert" className="mx-auto max-w-2xl rounded-xl border border-[#e4252c]/20 bg-white p-6 text-center shadow-sm">
        <h1 className="text-2xl font-semibold">Reporte de impuestos</h1>
        <p className="mt-3 text-sm leading-6 text-black/60">No fue posible calcular el reporte en este momento. Intente nuevamente.</p>
        <button type="button" onClick={reset} className="mt-5 min-h-11 rounded-lg bg-[#e4252c] px-5 font-semibold text-white hover:bg-[#c91d24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2">
          Intentar nuevamente
        </button>
      </section>
    </main>
  );
}
