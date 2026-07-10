"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, History, RotateCcw, Search, Upload, XCircle } from "lucide-react";
import {
  applyHistoricalPayableBatchAction,
  assignHistoricalPayableRowAction,
  cancelHistoricalPayableBatchAction,
  cancelHistoricalPayableRowAction,
  importHistoricalAccountsPayableAction,
  rollbackHistoricalPayableBatchAction,
} from "@/app/admin/cuentas-por-pagar/actions";
import { searchImportAssignmentOptionsAction } from "@/app/admin/importaciones/actions";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { HistoricalPayableImportActionState, HistoricalPayableImportData } from "@/types/accounts-payable-import";
import type { AssignmentSelectorOption, ImportBatch, ImportRow } from "@/types/import-foundation";
import { importBatchStatusLabels } from "@/utils/import-labels";
import { formatCurrency } from "@/utils/pricing";

const initialImportState: HistoricalPayableImportActionState = { ok: false, message: "", errors: [] };
const pageSize = 25;

const statusBadgeClass: Record<string, string> = {
  good: "border-[#2f6f3e]/20 bg-[#edf7ed] text-[#2f6f3e]",
  warn: "border-[#b45309]/20 bg-[#fff7ed] text-[#92400e]",
  bad: "border-[#e4252c]/20 bg-[#fff1f2] text-[#7f1d1d]",
  neutral: "border-black/10 bg-[#f4f4f5] text-black/65",
};

type ConfirmationDraft = {
  row: ImportRow;
  option: AssignmentSelectorOption;
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="dark" disabled={pending} className="w-full sm:w-auto">
      <Upload size={16} />
      {pending ? "Importando" : "Importar Excel"}
    </Button>
  );
}

export function AccountsPayableImportManager({ data }: { data: HistoricalPayableImportData }) {
  const router = useRouter();
  const toast = useToast();
  const [state, formAction] = useActionState(importHistoricalAccountsPayableAction, initialImportState);
  const [isPending, startTransition] = useTransition();
  const [searchByRow, setSearchByRow] = useState<Record<string, string>>({});
  const [optionsByRow, setOptionsByRow] = useState<Record<string, AssignmentSelectorOption[]>>({});
  const [rollbackReason, setRollbackReason] = useState("");
  const [pageState, setPageState] = useState({ batchId: "", page: 1 });
  const [confirmationDraft, setConfirmationDraft] = useState<ConfirmationDraft | null>(null);

  const selectedId = data.selectedBatch?.id ?? "";
  const page = pageState.batchId === selectedId ? pageState.page : 1;
  const totalPages = Math.max(1, Math.ceil(data.rows.length / pageSize));
  const visibleRows = data.rows.slice((page - 1) * pageSize, page * pageSize);
  const allOptions = useMemo(() => {
    const map = new Map<string, AssignmentSelectorOption>();
    for (const option of data.assignmentOptions) map.set(option.id, option);
    for (const options of Object.values(optionsByRow)) for (const option of options) map.set(option.id, option);
    return map;
  }, [data.assignmentOptions, optionsByRow]);

  useEffect(() => {
    if (!state.message) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
    if (state.batchId) router.replace(`/admin/cuentas-por-pagar?importBatch=${state.batchId}`);
    router.refresh();
  }, [router, state, toast]);


  function runAction(action: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const result = await action().catch((error) => ({ ok: false, message: error instanceof Error ? error.message : "No se pudo completar la accion." }));
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      router.refresh();
    });
  }

  function searchSuppliers(row: ImportRow) {
    const query = (searchByRow[row.id] || String(row.normalized_data.supplier_name ?? "")).trim();
    if (query.length < 2) {
      toast.error("Ingresa al menos 2 caracteres para buscar.");
      return;
    }

    startTransition(async () => {
      const options = await searchImportAssignmentOptionsAction("supplier", query);
      setOptionsByRow((current) => ({ ...current, [row.id]: options }));
    });
  }

  function openConfirmation(row: ImportRow, option: AssignmentSelectorOption) {
    setConfirmationDraft({ row, option });
  }

  function confirmSupplier() {
    if (!confirmationDraft) return;
    const { row, option } = confirmationDraft;
    setConfirmationDraft(null);
    runAction(() => assignHistoricalPayableRowAction(row.id, option.id));
  }

  function exportRows() {
    const headers = ["Fila", "Proveedor importado", "Factura proveedor", "Estado fila", "Monto original", "Monto pagado", "Saldo", "Mensajes"];
    const lines = data.rows.map((row) => {
      const normalized = row.normalized_data;
      return [
        row.row_number,
        normalized.supplier_name ?? "",
        normalized.supplier_invoice_number ?? "",
        rowStatusLabel(row),
        normalized.original_amount ?? "",
        normalized.paid_amount ?? "",
        normalized.balance_due ?? "",
        row.validation_messages.join(" | "),
      ].map(csvCell).join(",");
    });
    const blob = new Blob([[headers.map(csvCell).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `resultado-importacion-cxp-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileSpreadsheet size={19} />
            <h2 className="text-base font-semibold">Importacion historica CxP</h2>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {data.canImport ? (
            <a href="/api/admin/cuentas-por-pagar/plantilla-historica/excel" download className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-[#fff1f2]">
              <Download size={16} />
              Descargar plantilla de cuentas por pagar
            </a>
          ) : null}
          {data.rows.length > 0 ? (
            <Button type="button" onClick={exportRows} variant="ghost">
              <Download size={16} />
              Exportar resultados
            </Button>
          ) : null}
        </div>
      </div>

      {data.canImport ? (
        <form action={formAction} className="mt-4 rounded-md border border-black/10 bg-[#fafafa] p-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-black/50">Archivo Excel</span>
            <input
              name="file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="block w-full min-w-0 rounded-md border border-black/10 bg-white px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[#080808] file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white focus:border-[#e4252c] focus:outline-none focus:ring-2 focus:ring-[#e4252c]/15"
              required
            />
          </label>
          <div className="mt-3 flex justify-end">
            <SubmitButton />
          </div>
        </form>
      ) : null}

      {state.message ? (
        <div className={`mt-3 rounded-md border p-3 text-sm ${state.ok ? statusBadgeClass.good : statusBadgeClass.bad}`}>
          <div className="flex items-start gap-2">
            {state.ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            <div className="min-w-0">
              <p className="font-semibold">{state.message}</p>
              {state.errors.length > 0 ? <p className="mt-1 break-words">{state.errors.slice(0, 3).join(" | ")}</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="min-w-0 rounded-md border border-black/10 bg-[#fafafa] p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <History size={16} />
            Historial
          </div>
          <div className="max-h-96 space-y-2 overflow-auto pr-1">
            {data.batches.map((batch, index) => (
              <a key={batch.id} href={`/admin/cuentas-por-pagar?importBatch=${batch.id}`} className={`block rounded-md border p-3 text-sm ${batch.id === selectedId ? "border-[#e4252c]/30 bg-[#fff1f2]" : "border-black/10 bg-white hover:bg-[#f4f4f5]"}`}>
                <span className="font-semibold">Import #{data.batches.length - index}</span>
                <span className="mt-1 block text-xs text-black/55">{formatDateTime(batch.created_at)}</span>
                <span className="mt-2 flex flex-wrap gap-1">
                  <Badge tone={batch.status === "applied" ? "good" : batch.status === "failed" ? "bad" : "neutral"}>{importBatchStatusLabels[batch.status]}</Badge>
                  <Badge tone="neutral">{batch.total_rows.toLocaleString("es-HN")} filas</Badge>
                </span>
              </a>
            ))}
            {data.batches.length === 0 ? <p className="rounded-md border border-black/10 bg-white p-3 text-sm text-black/55">Sin importaciones registradas.</p> : null}
          </div>
        </aside>

        <div className="min-w-0 space-y-4">
          {data.selectedBatch ? (
            <>
              <BatchSummary batch={data.selectedBatch} rows={data.rows} />
              <div className="flex flex-wrap gap-2">
                {data.canApply && readyRows(data.rows) > 0 ? (
                  <Button type="button" onClick={() => runAction(() => applyHistoricalPayableBatchAction(data.selectedBatch!.id))} disabled={isPending} variant="primary">
                    <Upload size={16} />
                    Aplicar listas
                  </Button>
                ) : null}
                {data.canImport && !["applied", "rolled_back", "cancelled"].includes(data.selectedBatch.status) ? (
                  <Button type="button" onClick={() => runAction(() => cancelHistoricalPayableBatchAction(data.selectedBatch!.id))} disabled={isPending} variant="ghost">
                    <XCircle size={16} />
                    Cancelar lote
                  </Button>
                ) : null}
                {data.canRollback && data.selectedBatch.status === "applied" ? (
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                    <input value={rollbackReason} onChange={(event) => setRollbackReason(event.target.value)} placeholder="Motivo de rollback" className="min-w-0 rounded-md border border-black/10 px-3 py-2 text-sm" />
                    <Button type="button" onClick={() => runAction(() => rollbackHistoricalPayableBatchAction(data.selectedBatch!.id, rollbackReason))} disabled={isPending} variant="ghost">
                      <RotateCcw size={16} />
                      Rollback
                    </Button>
                  </div>
                ) : null}
              </div>

              <RowsTable
                rows={visibleRows}
                allOptions={allOptions}
                optionsByRow={optionsByRow}
                searchByRow={searchByRow}
                canAssign={data.canAssign}
                canImport={data.canImport}
                isPending={isPending}
                onSearchChange={(rowId, value) => setSearchByRow((current) => ({ ...current, [rowId]: value }))}
                onSearch={searchSuppliers}
                onAssign={openConfirmation}
                onCancel={(rowId) => runAction(() => cancelHistoricalPayableRowAction(rowId))}
              />
              {data.rows.length > pageSize ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-black/10 bg-[#fafafa] px-3 py-2 text-sm">
                  <span>Pagina {page} de {totalPages}</span>
                  <div className="flex gap-2">
                    <Button type="button" variant="ghost" disabled={page <= 1} onClick={() => setPageState({ batchId: selectedId, page: Math.max(1, page - 1) })}>Anterior</Button>
                    <Button type="button" variant="ghost" disabled={page >= totalPages} onClick={() => setPageState({ batchId: selectedId, page: Math.min(totalPages, page + 1) })}>Siguiente</Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className="rounded-md border border-black/10 bg-[#f4f4f5] p-4 text-sm text-black/55">No hay lote seleccionado.</p>
          )}
        </div>
      </div>

      {confirmationDraft ? (
        <SupplierConfirmationDialog draft={confirmationDraft} isPending={isPending} onCancel={() => setConfirmationDraft(null)} onConfirm={confirmSupplier} />
      ) : null}
    </section>
  );
}

function BatchSummary({ batch, rows }: { batch: ImportBatch; rows: ImportRow[] }) {
  const errors = rows.filter((row) => row.validation_status === "invalid").length;
  const pendingAssignment = rows.filter((row) => ["pending", "unassigned"].includes(row.assignment_status)).length;
  const pendingConfirmation = rows.filter((row) => row.assignment_status === "suggested").length;
  const ready = readyRows(rows);
  const rollbackAvailable = batch.status === "applied" && rows.some((row) => row.apply_status === "applied");

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      <SummaryBadge label="Total de filas" value={batch.total_rows} tone="neutral" />
      <SummaryBadge label="Validadas" value={batch.validated_rows} tone="good" />
      <SummaryBadge label="Pendientes de asignacion" value={pendingAssignment} tone={pendingAssignment > 0 ? "warn" : "neutral"} />
      <SummaryBadge label="Pendientes de confirmacion" value={pendingConfirmation} tone={pendingConfirmation > 0 ? "warn" : "neutral"} />
      <SummaryBadge label="Con errores" value={errors || batch.failed_rows} tone={errors > 0 || batch.failed_rows > 0 ? "bad" : "neutral"} />
      <SummaryBadge label="Listas para aplicar" value={ready} tone={ready > 0 ? "good" : "neutral"} />
      <SummaryBadge label="Aplicadas" value={batch.applied_rows} tone={batch.applied_rows > 0 ? "good" : "neutral"} />
      <SummaryBadge label="Canceladas" value={rows.filter((row) => row.apply_status === "skipped").length} tone="neutral" />
      <SummaryBadge label="Revertidas" value={rows.filter((row) => row.apply_status === "rolled_back").length} tone="neutral" />
      <SummaryBadge label="Rollback disponible" value={rollbackAvailable ? "Si" : "No"} tone={rollbackAvailable ? "warn" : "neutral"} />
    </div>
  );
}

function RowsTable({
  rows,
  allOptions,
  optionsByRow,
  searchByRow,
  canAssign,
  canImport,
  isPending,
  onSearchChange,
  onSearch,
  onAssign,
  onCancel,
}: {
  rows: ImportRow[];
  allOptions: Map<string, AssignmentSelectorOption>;
  optionsByRow: Record<string, AssignmentSelectorOption[]>;
  searchByRow: Record<string, string>;
  canAssign: boolean;
  canImport: boolean;
  isPending: boolean;
  onSearchChange: (rowId: string, value: string) => void;
  onSearch: (row: ImportRow) => void;
  onAssign: (row: ImportRow, option: AssignmentSelectorOption) => void;
  onCancel: (rowId: string) => void;
}) {
  return (
    <div className="max-w-full overflow-x-auto rounded-md border border-black/10">
      <table className="w-full min-w-[1240px] text-left text-sm">
        <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
          <tr>
            <th className="px-3 py-2">Fila</th>
            <th className="px-3 py-2">Proveedor importado</th>
            <th className="px-3 py-2">Documento</th>
            <th className="px-3 py-2">Montos</th>
            <th className="px-3 py-2">Estado</th>
            <th className="px-3 py-2">Proveedor</th>
            <th className="px-3 py-2">Mensajes</th>
            <th className="px-3 py-2">Accion</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-black/10 bg-white">
          {rows.map((row) => {
            const normalized = row.normalized_data;
            const assigned = row.assigned_supplier_id ? allOptions.get(row.assigned_supplier_id) : null;
            const suggested = row.suggested_supplier_id ? allOptions.get(row.suggested_supplier_id) : null;
            const rowOptions = optionsByRow[row.id] ?? [];
            const canResolve = canAssign && row.apply_status !== "applied" && row.apply_status !== "rolled_back";
            return (
              <tr key={row.id}>
                <td className="px-3 py-3 align-top font-semibold">{row.row_number}</td>
                <td className="px-3 py-3 align-top">
                  <p className="break-words font-semibold">{String(normalized.supplier_name ?? "Sin proveedor")}</p>
                  <p className="break-words text-xs text-black/50">{[normalized.supplier_email, normalized.supplier_phone, normalized.supplier_tax_id ? `RTN ${normalized.supplier_tax_id}` : null].filter(Boolean).join(" | ")}</p>
                </td>
                <td className="px-3 py-3 align-top">
                  <p className="font-semibold">{String(normalized.supplier_invoice_number ?? "")}</p>
                  <p className="text-xs text-black/50">{String(normalized.issue_date ?? "")} / {String(normalized.due_date ?? "")}</p>
                </td>
                <td className="px-3 py-3 align-top">
                  <p>Original {formatCurrency(Number(normalized.original_amount ?? 0))}</p>
                  <p>Pagado {formatCurrency(Number(normalized.paid_amount ?? 0))}</p>
                  <p className="font-semibold">Saldo {formatCurrency(Number(normalized.balance_due ?? 0))}</p>
                </td>
                <td className="px-3 py-3 align-top"><Badge tone={rowStatusTone(row)}>{rowStatusLabel(row)}</Badge></td>
                <td className="px-3 py-3 align-top">
                  {assigned ? <PartyMini option={assigned} /> : suggested ? <PartyMini option={suggested} prefix="Coincidencia sugerida" /> : <span className="text-xs text-black/45">Pendiente de asignacion</span>}
                </td>
                <td className="px-3 py-3 align-top">
                  {row.validation_messages.length > 0 ? (
                    <ul className={`max-h-28 min-w-72 overflow-auto text-xs ${row.validation_status === "warning" ? "text-[#92400e]" : "text-[#7f1d1d]"}`}>
                      {row.validation_messages.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
                    </ul>
                  ) : <span className="text-xs text-black/45">Sin errores</span>}
                </td>
                <td className="px-3 py-3 align-top">
                  {canResolve ? (
                    <div className="grid min-w-64 gap-2">
                      <div className="flex gap-2">
                        <input value={searchByRow[row.id] ?? ""} onChange={(event) => onSearchChange(row.id, event.target.value)} placeholder="Nombre, correo, telefono, RTN" className="min-w-0 flex-1 rounded-md border border-black/10 px-2 py-1.5 text-xs" />
                        <button type="button" onClick={() => onSearch(row)} disabled={isPending} className="rounded-md border border-black/10 p-2 hover:bg-[#fff1f2]" aria-label="Buscar proveedor">
                          <Search size={15} />
                        </button>
                      </div>
                      {rowOptions.length > 0 ? (
                        <select
                          defaultValue=""
                          onChange={(event) => {
                            const option = rowOptions.find((item) => item.id === event.target.value);
                            if (option) onAssign(row, option);
                            event.currentTarget.value = "";
                          }}
                          disabled={isPending}
                          className="rounded-md border border-black/10 bg-white px-2 py-2 text-xs"
                        >
                          <option value="">Seleccionar proveedor</option>
                          {rowOptions.map((option) => <option key={option.id} value={option.id}>{partyOptionText(option)}</option>)}
                        </select>
                      ) : null}
                      {suggested && !assigned ? (
                        <Button type="button" onClick={() => onAssign(row, suggested)} disabled={isPending} variant="ghost">
                          <CheckCircle2 size={16} />
                          Confirmar proveedor
                        </Button>
                      ) : null}
                      {canImport && row.apply_status !== "skipped" ? (
                        <Button type="button" onClick={() => onCancel(row.id)} disabled={isPending} variant="ghost">
                          <XCircle size={16} />
                          Cancelar fila
                        </Button>
                      ) : null}
                    </div>
                  ) : <span className="text-xs text-black/45">Sin accion</span>}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 ? <tr><td colSpan={8} className="px-3 py-6 text-center text-black/55">Este lote no tiene filas.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

function SupplierConfirmationDialog({ draft, isPending, onCancel, onConfirm }: { draft: ConfirmationDraft; isPending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const normalized = draft.row.normalized_data;
  return (
    <div className="cz-layer-modal fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-black/45 p-3 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="supplier-confirmation-title">
      <div className="w-full max-w-xl rounded-lg bg-white p-4 shadow-xl">
        <h3 id="supplier-confirmation-title" className="text-base font-semibold">Confirmar proveedor</h3>
        <p className="mt-2 text-sm text-black/65">Revise cuidadosamente la informacion antes de vincular esta cuenta por pagar.</p>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <Info label="Proveedor importado" value={String(normalized.supplier_name ?? "")} />
          <Info label="Proveedor ERP" value={draft.option.name} />
          <Info label="Correo" value={draft.option.email ?? "Sin correo"} />
          <Info label="Telefono" value={draft.option.phone ?? "Sin telefono"} />
          <Info label="RTN" value={draft.option.taxId ?? "Sin RTN"} />
          <Info label="Factura proveedor" value={String(normalized.supplier_invoice_number ?? "")} />
          <Info label="Emision" value={String(normalized.issue_date ?? "")} />
          <Info label="Vencimiento" value={String(normalized.due_date ?? "")} />
          <Info label="Monto original" value={formatCurrency(Number(normalized.original_amount ?? 0))} />
          <Info label="Monto pagado" value={formatCurrency(Number(normalized.paid_amount ?? 0))} />
          <Info label="Saldo pendiente" value={formatCurrency(Number(normalized.balance_due ?? 0))} />
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isPending}>Cancelar</Button>
          <Button type="button" variant="primary" onClick={onConfirm} disabled={isPending}>
            <CheckCircle2 size={16} />
            Confirmar proveedor
          </Button>
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-black/10 bg-[#fafafa] p-2">
      <p className="text-xs font-semibold uppercase text-black/45">{label}</p>
      <p className="mt-1 break-words font-semibold">{value}</p>
    </div>
  );
}

function SummaryBadge({ label, value, tone }: { label: string; value: number | string; tone: keyof typeof statusBadgeClass }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${statusBadgeClass[tone]}`}>
      <p className="text-xs font-semibold uppercase">{label}</p>
      <p className="mt-1 text-lg font-semibold">{typeof value === "number" ? value.toLocaleString("es-HN") : value}</p>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: keyof typeof statusBadgeClass }) {
  return <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${statusBadgeClass[tone]}`}>{children}</span>;
}

function PartyMini({ option, prefix }: { option: AssignmentSelectorOption; prefix?: string }) {
  return (
    <div className="text-xs">
      {prefix ? <p className="font-semibold text-[#92400e]">{prefix}</p> : null}
      <p className="break-words font-semibold">{option.name}</p>
      <p className="break-words text-black/50">{[option.email, option.phone, option.taxId ? `RTN ${option.taxId}` : null].filter(Boolean).join(" | ")}</p>
    </div>
  );
}

function rowStatusLabel(row: ImportRow) {
  if (row.apply_status === "applied") return "Aplicada";
  if (row.apply_status === "rolled_back") return "Revertida";
  if (row.apply_status === "skipped") return "Cancelada";
  if (row.validation_status === "invalid") return "Error";
  if (row.assignment_status === "suggested") return "Pendiente de confirmacion";
  if (["pending", "unassigned"].includes(row.assignment_status)) return "Pendiente de asignacion";
  if (row.assignment_status === "confirmed") return "Lista para aplicar";
  return "Validada";
}

function rowStatusTone(row: ImportRow): keyof typeof statusBadgeClass {
  const label = rowStatusLabel(row);
  if (label === "Aplicada" || label === "Lista para aplicar" || label === "Validada") return "good";
  if (label === "Error") return "bad";
  if (label === "Pendiente de confirmacion" || label === "Pendiente de asignacion") return "warn";
  return "neutral";
}

function readyRows(rows: ImportRow[]) {
  return rows.filter((row) => row.validation_status !== "invalid" && row.assignment_status === "confirmed" && ["pending", "ready"].includes(row.apply_status)).length;
}

function partyOptionText(option: AssignmentSelectorOption) {
  return [option.name, option.email, option.phone, option.taxId ? `RTN ${option.taxId}` : null].filter(Boolean).join(" | ");
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function formatDateTime(value: string | null) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-HN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
