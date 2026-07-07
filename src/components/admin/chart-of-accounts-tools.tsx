"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileText, Upload } from "lucide-react";
import { importChartOfAccountsAction } from "@/app/admin/contabilidad/actions";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { ChartOfAccountsImportActionState } from "@/types/accounting-catalog";

const initialState: ChartOfAccountsImportActionState = {
  ok: false,
  message: "",
  errors: [],
};

const linkClass = "inline-flex max-w-full items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-4 py-2 text-center text-sm font-semibold leading-snug text-[#080808] transition-all duration-200 [overflow-wrap:anywhere] hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:bg-[#fff1f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2";

function SubmitImportButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="dark" disabled={pending} className="w-full sm:w-auto">
      <Upload size={16} />
      {pending ? "Validando archivo" : "Validar archivo"}
    </Button>
  );
}

export function ChartOfAccountsTools({
  canManage,
  canExport,
  canCsvExport,
}: {
  canManage: boolean;
  canExport: boolean;
  canCsvExport: boolean;
}) {
  const [state, formAction] = useActionState(importChartOfAccountsAction, initialState);
  const toast = useToast();

  useEffect(() => {
    if (!state.message) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state, toast]);

  if (!canManage && !canExport) return null;

  return (
    <section className="mb-4 rounded-lg border border-black/10 bg-[#fafafa] p-3 sm:p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileSpreadsheet size={19} />
            <h3 className="text-base font-semibold">Herramientas del catálogo de cuentas</h3>
          </div>
          <p className="mt-1 text-sm leading-6 text-black/55">Importación y exportación oficial para el catálogo contable.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {canManage ? (
            <a className={linkClass} href="/api/admin/contabilidad/catalogo-cuentas/plantilla/excel">
              <Download size={16} />
              Descargar plantilla Excel
            </a>
          ) : null}
          {canExport ? (
            <>
              <a className={linkClass} href="/api/admin/contabilidad/catalogo-cuentas/excel">
                <FileSpreadsheet size={16} />
                Exportar Excel
              </a>
              <a className={linkClass} href="/api/admin/contabilidad/catalogo-cuentas/pdf">
                <FileText size={16} />
                Exportar PDF
              </a>
            </>
          ) : null}
          {canCsvExport ? (
            <a className={linkClass} href="/api/admin/contabilidad/catalogo-cuentas/csv">
              <Download size={16} />
              Exportar CSV
            </a>
          ) : null}
        </div>
      </div>

      {canManage ? (
        <form action={formAction} className="mt-4 rounded-md border border-black/10 bg-white p-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">Importar catálogo desde Excel</span>
            <input
              name="file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="block w-full min-w-0 rounded-md border border-black/10 bg-white px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[#080808] file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white focus:border-[#e4252c] focus:outline-none focus:ring-2 focus:ring-[#e4252c]/15"
              required
            />
          </label>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-black/50">Solo archivos .xlsx. Si hay errores, no se modifica ninguna cuenta.</p>
            <SubmitImportButton />
          </div>
        </form>
      ) : null}

      {state.message ? (
        <div className={`mt-4 rounded-md border p-3 text-sm ${state.ok ? "border-[#2f6f3e]/20 bg-[#edf7ed] text-[#2f6f3e]" : "border-[#e4252c]/20 bg-[#fff1f2] text-[#7f1d1d]"}`}>
          <div className="flex items-start gap-2">
            {state.ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            <div className="min-w-0">
              <p className="font-semibold">{state.ok ? "Importación completada" : "Errores encontrados"}</p>
              <p className="mt-1">{state.message}</p>
            </div>
          </div>

          {state.summary ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Summary label="Filas procesadas" value={state.summary.processed} />
              <Summary label="Cuentas creadas" value={state.summary.created} />
              <Summary label="Cuentas actualizadas" value={state.summary.updated} />
              <Summary label="Cuentas omitidas" value={state.summary.skipped} />
            </div>
          ) : null}

          {state.errors.length > 0 ? (
            <div className="mt-3 max-h-72 overflow-auto rounded-md border border-current/20 bg-white/60">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="sticky top-0 bg-white text-xs uppercase text-black/50">
                  <tr>
                    <th className="px-3 py-2">Detalle</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-current/10">
                  {state.errors.map((error, index) => (
                    <tr key={`${error}-${index}`}>
                      <td className="px-3 py-2">{error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-md border border-current/15 bg-white/60 px-3 py-2">
      {label}: <strong>{value.toLocaleString("es-HN")}</strong>
    </span>
  );
}