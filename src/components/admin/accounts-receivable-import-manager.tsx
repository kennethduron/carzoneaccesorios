"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, History, RotateCcw, Search, Upload, UserRoundPlus, XCircle } from "lucide-react";
import {
  applyHistoricalReceivableBatchAction,
  assignHistoricalReceivableRowAction,
  cancelHistoricalReceivableBatchAction,
  cancelHistoricalReceivableRowAction,
  importHistoricalAccountsReceivableAction,
  rollbackHistoricalReceivableBatchAction,
  updateHistoricalReceivableIdentityAction,
} from "@/app/admin/cuentas-por-cobrar/actions";
import { searchImportAssignmentOptionsAction } from "@/app/admin/importaciones/actions";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { HistoricalReceivableImportActionState, HistoricalReceivableImportData } from "@/types/accounts-receivable-import";
import type { AssignmentSelectorOption, ImportBatch, ImportRow } from "@/types/import-foundation";
import { importBatchStatusLabels } from "@/utils/import-labels";
import { formatCurrency } from "@/utils/pricing";

const initialImportState: HistoricalReceivableImportActionState = { ok: false, message: "", errors: [] };

type ConfirmationDraft = {
  row: ImportRow;
  option: AssignmentSelectorOption;
};

type IdentityDraft = {
  row: ImportRow;
  email: string;
  phone: string;
  taxId: string;
};

const statusBadgeClass: Record<string, string> = {
  good: "border-[#2f6f3e]/20 bg-[#edf7ed] text-[#2f6f3e]",
  warn: "border-[#b45309]/20 bg-[#fff7ed] text-[#92400e]",
  bad: "border-[#e4252c]/20 bg-[#fff1f2] text-[#7f1d1d]",
  neutral: "border-black/10 bg-[#f4f4f5] text-black/65",
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

export function AccountsReceivableImportManager({ data }: { data: HistoricalReceivableImportData }) {
  const router = useRouter();
  const toast = useToast();
  const [state, formAction] = useActionState(importHistoricalAccountsReceivableAction, initialImportState);
  const [isPending, startTransition] = useTransition();
  const [searchByRow, setSearchByRow] = useState<Record<string, string>>({});
  const [optionsByRow, setOptionsByRow] = useState<Record<string, AssignmentSelectorOption[]>>({});
  const [rollbackReason, setRollbackReason] = useState("");
  const [confirmationDraft, setConfirmationDraft] = useState<ConfirmationDraft | null>(null);
  const [identityDraft, setIdentityDraft] = useState<IdentityDraft | null>(null);
  const [applyConfirmationOpen, setApplyConfirmationOpen] = useState(false);

  const selectedId = data.selectedBatch?.id ?? "";
  const allOptions = useMemo(() => {
    const map = new Map<string, AssignmentSelectorOption>();
    for (const option of data.assignmentOptions) map.set(option.id, option);
    for (const options of Object.values(optionsByRow)) {
      for (const option of options) map.set(option.id, option);
    }
    return map;
  }, [data.assignmentOptions, optionsByRow]);
  const previewByRow = useMemo(
    () => new Map((data.preview?.rows ?? []).map((row) => [row.row_id, row])),
    [data.preview],
  );

  useEffect(() => {
    if (!state.message) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
    if (state.batchId) router.replace(`/admin/cuentas-por-cobrar?importBatch=${state.batchId}`);
    router.refresh();
  }, [router, state, toast]);

  function runAction(action: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const result = await action().catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : "No se pudo completar la acción.",
      }));
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      router.refresh();
    });
  }

  function openConfirmation(row: ImportRow, option: AssignmentSelectorOption) {
    setConfirmationDraft({ row, option });
  }

  function confirmCustomer() {
    if (!confirmationDraft) return;
    const { row, option } = confirmationDraft;
    setConfirmationDraft(null);
    runAction(() => assignHistoricalReceivableRowAction(row.id, option.id));
  }

  function openIdentity(row: ImportRow) {
    setIdentityDraft({
      row,
      email: String(row.normalized_data.customer_email ?? ""),
      phone: String(row.normalized_data.customer_phone ?? ""),
      taxId: String(row.normalized_data.customer_tax_id ?? ""),
    });
  }

  function saveIdentity() {
    if (!identityDraft) return;
    const draft = identityDraft;
    setIdentityDraft(null);
    runAction(() => updateHistoricalReceivableIdentityAction(draft.row.id, {
      email: draft.email,
      phone: draft.phone,
      taxId: draft.taxId,
    }));
  }

  function confirmAndApply() {
    if (!data.selectedBatch) return;
    const batchId = data.selectedBatch.id;
    setApplyConfirmationOpen(false);
    runAction(() => applyHistoricalReceivableBatchAction(batchId));
  }

  function searchCustomers(row: ImportRow) {
    const query = (searchByRow[row.id] || String(row.normalized_data.customer_name ?? "")).trim();
    if (query.length < 2) {
      toast.error("Ingresa al menos 2 caracteres para buscar.");
      return;
    }

    startTransition(async () => {
      const options = await searchImportAssignmentOptionsAction("customer", query);
      setOptionsByRow((current) => ({ ...current, [row.id]: options }));
    });
  }

  function exportRows() {
    const headers = ["Fila", "Cliente importado", "Factura", "Estado fila", "Monto original", "Monto pagado", "Saldo", "Mensajes"];
    const lines = data.rows.map((row) => {
      const normalized = row.normalized_data;
      return [
        row.row_number,
        normalized.customer_name ?? "",
        normalized.invoice_number ?? "",
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
    link.download = `resultado-importacion-cxc-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileSpreadsheet size={19} />
            <h2 className="text-base font-semibold">Importación histórica CxC</h2>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {data.canImport ? (
            <a href="/api/admin/cuentas-por-cobrar/plantilla-historica/excel" download className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-[#fff1f2]">
              <Download size={16} />
              Plantilla Excel
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
              <a
                key={batch.id}
                href={`/admin/cuentas-por-cobrar?importBatch=${batch.id}`}
                className={`block rounded-md border p-3 text-sm ${batch.id === selectedId ? "border-[#e4252c]/30 bg-[#fff1f2]" : "border-black/10 bg-white hover:bg-[#f4f4f5]"}`}
              >
                <span className="font-semibold">Importación #{data.batches.length - index}</span>
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
              <DirectImportPreview preview={data.preview} batch={data.selectedBatch} rows={data.rows} />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => setApplyConfirmationOpen(true)}
                  disabled={isPending || !data.canApply || data.selectedBatch.status === "cancelled" || (data.preview?.processable ?? 0) === 0}
                  variant="primary"
                  title={confirmDisabledReason(data)}
                >
                  <Upload size={16} />
                  {isPending ? "Importando cuentas por cobrar..." : "Confirmar e importar cuentas por cobrar"}
                </Button>
                {data.canImport && !["applied", "rolled_back", "cancelled"].includes(data.selectedBatch.status) ? (
                  <Button type="button" onClick={() => runAction(() => cancelHistoricalReceivableBatchAction(data.selectedBatch!.id))} disabled={isPending} variant="ghost">
                    <XCircle size={16} />
                    Cancelar lote
                  </Button>
                ) : null}
                {data.canRollback && data.selectedBatch.status === "applied" ? (
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                    <input
                      value={rollbackReason}
                      onChange={(event) => setRollbackReason(event.target.value)}
                      placeholder="Motivo de reversión"
                      className="min-w-0 rounded-md border border-black/10 px-3 py-2 text-sm"
                    />
                    <Button type="button" onClick={() => runAction(() => rollbackHistoricalReceivableBatchAction(data.selectedBatch!.id, rollbackReason))} disabled={isPending} variant="ghost">
                      <RotateCcw size={16} />
                      Revertir
                    </Button>
                  </div>
                ) : null}
              </div>

              <RowsTable
                rows={data.rows}
                allOptions={allOptions}
                optionsByRow={optionsByRow}
                searchByRow={searchByRow}
                canAssign={data.canAssign}
                canImport={data.canImport}
                isPending={isPending}
                onSearchChange={(rowId, value) => setSearchByRow((current) => ({ ...current, [rowId]: value }))}
                onSearch={searchCustomers}
                onAssign={openConfirmation}
                onEditIdentity={openIdentity}
                previewByRow={previewByRow}
                onCancel={(rowId) => runAction(() => cancelHistoricalReceivableRowAction(rowId))}
              />
              {confirmationDraft ? (
                <CustomerConfirmationDialog draft={confirmationDraft} isPending={isPending} onCancel={() => setConfirmationDraft(null)} onConfirm={confirmCustomer} />
              ) : null}
              {identityDraft ? (
                <IdentityDialog draft={identityDraft} isPending={isPending} onChange={setIdentityDraft} onCancel={() => setIdentityDraft(null)} onConfirm={saveIdentity} />
              ) : null}
              {applyConfirmationOpen && data.preview ? (
                <ApplyConfirmationDialog preview={data.preview} isPending={isPending} onCancel={() => setApplyConfirmationOpen(false)} onConfirm={confirmAndApply} />
              ) : null}
            </>
          ) : (
            <p className="rounded-md border border-black/10 bg-[#f4f4f5] p-4 text-sm text-black/55">No hay lote seleccionado.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function confirmDisabledReason(data: HistoricalReceivableImportData) {
  if (!data.canApply) return "No tienes permiso para confirmar importaciones.";
  if (data.selectedBatch?.status === "cancelled") return "Este lote fue cancelado. Corrige el archivo y vuelve a importarlo.";
  if ((data.preview?.processable ?? 0) === 0) return "Completa la identidad o asigna un cliente en las filas en revisión.";
  return "Revisa el resumen antes de confirmar.";
}

function DirectImportPreview({ preview, batch, rows }: { preview: HistoricalReceivableImportData["preview"]; batch: ImportBatch; rows: ImportRow[] }) {
  if (batch.status === "cancelled") {
    return <p className="rounded-md border border-[#b45309]/20 bg-[#fff7ed] p-3 text-sm text-[#92400e]">Este lote fue cancelado. Corrige el archivo y vuelve a importarlo.</p>;
  }
  if (!preview) return null;
  const validRows = rows.filter((row) => row.validation_status === "valid" || row.validation_status === "warning").length;
  const cancelledRows = rows.filter((row) => row.apply_status === "skipped").length;
  return (
    <div className="border-y border-black/10 py-4">
      <h3 className="text-sm font-semibold">Próximo paso</h3>
      <ol className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
        <li>1. Revisar resumen</li><li>2. Confirmar e importar</li><li>3. Registrar abonos en el detalle</li>
      </ol>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryBadge label="Válidas" value={validRows} tone="good" />
        <SummaryBadge label="Crearán cliente" value={preview.create_customers} tone="good" />
        <SummaryBadge label="Reutilizarán cliente" value={preview.reuse_customers} tone="neutral" />
        <SummaryBadge label="CxC por crear" value={preview.create_receivables} tone="good" />
        <SummaryBadge label="Ambiguas" value={preview.ambiguous} tone={preview.ambiguous ? "warn" : "neutral"} />
        <SummaryBadge label="Duplicadas" value={preview.duplicates} tone="neutral" />
        <SummaryBadge label="Con error" value={preview.rejected} tone={preview.rejected ? "bad" : "neutral"} />
        <SummaryBadge label="Canceladas" value={cancelledRows} tone={cancelledRows ? "warn" : "neutral"} />
      </div>
    </div>
  );
}

function ApplyConfirmationDialog({ preview, isPending, onCancel, onConfirm }: { preview: NonNullable<HistoricalReceivableImportData["preview"]>; isPending: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="cz-layer-modal fixed inset-0 z-[80] grid place-items-center bg-black/45 p-3" role="dialog" aria-modal="true" aria-labelledby="apply-import-title">
      <div className="w-full max-w-lg rounded-lg bg-white p-4 shadow-xl">
        <h3 id="apply-import-title" className="text-base font-semibold">Confirmar importación operativa</h3>
        <div className="mt-3 space-y-1 text-sm text-black/70">
          <p>Se crearán {preview.create_receivables} cuentas por cobrar.</p>
          <p>Se crearán {preview.create_customers} clientes operativos sin cuenta web.</p>
          <p>Se reutilizarán {preview.reuse_customers} clientes existentes.</p>
          <p>{preview.review_required} filas quedarán en revisión.</p>
          <p>{preview.duplicates + preview.rejected} filas serán omitidas por duplicidad o error.</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isPending}>Cancelar</Button>
          <Button type="button" variant="primary" onClick={onConfirm} disabled={isPending}>Confirmar e importar</Button>
        </div>
      </div>
    </div>
  );
}

function IdentityDialog({ draft, isPending, onChange, onCancel, onConfirm }: { draft: IdentityDraft; isPending: boolean; onChange: (draft: IdentityDraft) => void; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="cz-layer-modal fixed inset-0 z-[80] grid place-items-center bg-black/45 p-3" role="dialog" aria-modal="true" aria-labelledby="identity-title">
      <div className="w-full max-w-lg rounded-lg bg-white p-4 shadow-xl">
        <h3 id="identity-title" className="text-base font-semibold">Completar identidad del cliente</h3>
        <p className="mt-2 text-sm text-black/60">Ingresa al menos RTN, correo o teléfono. El nombre por sí solo no se usa para vincular automáticamente.</p>
        <div className="mt-4 grid gap-3">
          <label className="text-sm">Correo<input type="email" value={draft.email} onChange={(event) => onChange({ ...draft, email: event.target.value })} className="mt-1 w-full rounded-md border border-black/10 px-3 py-2" /></label>
          <label className="text-sm">Teléfono<input value={draft.phone} onChange={(event) => onChange({ ...draft, phone: event.target.value })} className="mt-1 w-full rounded-md border border-black/10 px-3 py-2" /></label>
          <label className="text-sm">RTN<input value={draft.taxId} onChange={(event) => onChange({ ...draft, taxId: event.target.value })} className="mt-1 w-full rounded-md border border-black/10 px-3 py-2" /></label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isPending}>Cancelar</Button>
          <Button type="button" variant="primary" onClick={onConfirm} disabled={isPending}>Guardar identidad</Button>
        </div>
      </div>
    </div>
  );
}
function CustomerConfirmationDialog({ draft, isPending, onCancel, onConfirm }: { draft: ConfirmationDraft; isPending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const normalized = draft.row.normalized_data;
  return (
    <div className="cz-layer-modal fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-black/45 p-3 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="customer-confirmation-title">
      <div className="w-full max-w-xl rounded-lg bg-white p-4 shadow-xl">
        <h3 id="customer-confirmation-title" className="text-base font-semibold">Confirmar cliente</h3>
        <p className="mt-2 text-sm text-black/65">Revise cuidadosamente la información antes de vincular esta cuenta por cobrar.</p>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <Info label="Cliente" value={draft.option.name} />
          <Info label="Correo" value={draft.option.email ?? "Sin correo"} />
          <Info label="Teléfono" value={draft.option.phone ?? "Sin teléfono"} />
          <Info label="RTN" value={draft.option.taxId ?? "Sin RTN"} />
          <Info label="Factura" value={String(normalized.invoice_number ?? "")} />
          <Info label="Monto original" value={formatCurrency(Number(normalized.original_amount ?? 0))} />
          <Info label="Monto pagado" value={formatCurrency(Number(normalized.paid_amount ?? 0))} />
          <Info label="Saldo pendiente" value={formatCurrency(Number(normalized.balance_due ?? 0))} />
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isPending}>Cancelar</Button>
          <Button type="button" variant="primary" onClick={onConfirm} disabled={isPending}>
            <CheckCircle2 size={16} />
            Confirmar cliente
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
function BatchSummary({ batch, rows }: { batch: ImportBatch; rows: ImportRow[] }) {
  const errors = rows.filter((row) => row.validation_status === "invalid").length;
  const pending = rows.filter((row) => ["pending", "unassigned"].includes(row.assignment_status)).length;
  const pendingConfirmation = rows.filter((row) => row.assignment_status === "suggested").length;
  const ready = readyRows(rows);
  const rollbackAvailable = batch.status === "applied" && rows.some((row) => row.apply_status === "applied");

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryBadge label="Total de filas" value={batch.total_rows} tone="neutral" />
      <SummaryBadge label="Validadas" value={batch.validated_rows} tone="good" />
      <SummaryBadge label="Pendientes de asignación" value={pending} tone={pending > 0 ? "warn" : "neutral"} />
      <SummaryBadge label="Pendientes de confirmación" value={pendingConfirmation} tone={pendingConfirmation > 0 ? "warn" : "neutral"} />
      <SummaryBadge label="Filas con errores" value={errors || batch.failed_rows} tone={errors > 0 || batch.failed_rows > 0 ? "bad" : "neutral"} />
      <SummaryBadge label="Listas para aplicar" value={ready} tone={ready > 0 ? "good" : "neutral"} />
      <SummaryBadge label="Aplicadas" value={batch.applied_rows} tone={batch.applied_rows > 0 ? "good" : "neutral"} />
      <SummaryBadge label="Canceladas" value={rows.filter((row) => row.apply_status === "skipped").length} tone="neutral" />
      <SummaryBadge label="Reversión disponible" value={rollbackAvailable ? "Si" : "No"} tone={rollbackAvailable ? "warn" : "neutral"} />
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
  onEditIdentity,
  previewByRow,
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
  onEditIdentity: (row: ImportRow) => void;
  previewByRow: Map<string, { outcome: string; reason: string }>;
  onCancel: (rowId: string) => void;
}) {
  return (
    <>
      <div className="grid gap-3 md:hidden">
        {rows.map((row) => {
          const normalized = row.normalized_data;
          const assigned = row.assigned_customer_id ? allOptions.get(row.assigned_customer_id) : null;
          const suggested = row.suggested_customer_id ? allOptions.get(row.suggested_customer_id) : null;
          const rowOptions = optionsByRow[row.id] ?? [];
          const canResolve = canAssign && row.apply_status !== "applied" && row.apply_status !== "rolled_back";
          const preview = previewByRow.get(row.id);
          return (
            <article key={row.id} className="rounded-md border border-black/10 bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-black/45">Fila {row.row_number}</p>
                  <p className="break-words font-semibold">{String(normalized.customer_name ?? "Sin cliente")}</p>
                  <p className="break-words text-xs text-black/50">{String(normalized.invoice_number ?? "Sin factura")}</p>
                </div>
                <Badge tone={rowStatusTone(row)}>{rowStatusLabel(row)}</Badge>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <Info label="Monto original" value={formatCurrency(Number(normalized.original_amount ?? 0))} />
                <Info label="Abonado" value={formatCurrency(Number(normalized.paid_amount ?? 0))} />
                <Info label="Saldo" value={formatCurrency(Number(normalized.balance_due ?? 0))} />
              </div>
              <div className="mt-3">
                {assigned ? <CustomerMini option={assigned} /> : suggested ? <CustomerMini option={suggested} prefix="Sugerido" /> : <span className="text-xs text-black/45">Pendiente de asignación</span>}
              </div>
              {preview ? <p className="mt-2 text-xs text-black/55">{preview.reason}</p> : null}
              {canResolve ? (
                <div className="mt-3 grid gap-2 border-t border-black/10 pt-3">
                  <div className="flex gap-2">
                    <input
                      value={searchByRow[row.id] ?? ""}
                      onChange={(event) => onSearchChange(row.id, event.target.value)}
                      placeholder="Nombre, correo, teléfono, RTN"
                      className="min-w-0 flex-1 rounded-md border border-black/10 px-2 py-2 text-xs"
                    />
                    <button type="button" onClick={() => onSearch(row)} disabled={isPending} className="rounded-md border border-black/10 p-2 hover:bg-[#fff1f2]" aria-label="Buscar cliente">
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
                      className="w-full rounded-md border border-black/10 bg-white px-2 py-2 text-xs"
                    >
                      <option value="">Seleccionar cliente</option>
                      {rowOptions.map((option) => (
                        <option key={option.id} value={option.id}>{customerOptionText(option)}</option>
                      ))}
                    </select>
                  ) : null}
                  <Button type="button" onClick={() => onEditIdentity(row)} disabled={isPending} variant="ghost">
                    <UserRoundPlus size={16} />
                    Completar identidad
                  </Button>
                  {suggested && !assigned ? (
                    <Button type="button" onClick={() => onAssign(row, suggested)} disabled={isPending} variant="ghost">
                      <CheckCircle2 size={16} />
                      Confirmar asignación
                    </Button>
                  ) : null}
                  {canImport && row.apply_status !== "skipped" ? (
                    <Button type="button" onClick={() => onCancel(row.id)} disabled={isPending} variant="ghost">
                      <XCircle size={16} />
                      Cancelar fila
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
        {rows.length === 0 ? <p className="rounded-md border border-black/10 bg-white p-5 text-center text-sm text-black/55">Este lote no tiene filas.</p> : null}
      </div>
      <div className="hidden max-w-full overflow-x-auto rounded-md border border-black/10 md:block">
      <table className="w-full min-w-[1180px] text-left text-sm">
        <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
          <tr>
            <th className="px-3 py-2">Fila</th>
            <th className="px-3 py-2">Cliente importado</th>
            <th className="px-3 py-2">Factura</th>
            <th className="px-3 py-2">Montos</th>
            <th className="px-3 py-2">Estado</th>
            <th className="px-3 py-2">Cliente asignado</th>
            <th className="px-3 py-2">Mensajes</th>
            <th className="sticky right-0 z-10 border-l border-black/10 bg-[#e7e5e4] px-3 py-2">Acción</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-black/10 bg-white">
          {rows.map((row) => {
            const normalized = row.normalized_data;
            const assigned = row.assigned_customer_id ? allOptions.get(row.assigned_customer_id) : null;
            const suggested = row.suggested_customer_id ? allOptions.get(row.suggested_customer_id) : null;
            const rowOptions = optionsByRow[row.id] ?? [];
            const canResolve = canAssign && row.apply_status !== "applied" && row.apply_status !== "rolled_back";
            const preview = previewByRow.get(row.id);
            return (
              <tr key={row.id}>
                <td className="px-3 py-3 align-top font-semibold">{row.row_number}</td>
                <td className="px-3 py-3 align-top">
                  <p className="font-semibold">{String(normalized.customer_name ?? "Sin cliente")}</p>
                  <p className="text-xs text-black/50">{[normalized.customer_email, normalized.customer_phone, normalized.customer_tax_id ? `RTN ${normalized.customer_tax_id}` : null].filter(Boolean).join(" | ")}</p>
                </td>
                <td className="px-3 py-3 align-top">
                  <p className="font-semibold">{String(normalized.invoice_number ?? "")}</p>
                  <p className="text-xs text-black/50">{String(normalized.issue_date ?? "")} / {String(normalized.due_date ?? "")}</p>
                </td>
                <td className="px-3 py-3 align-top">
                  <p>Monto original {formatCurrency(Number(normalized.original_amount ?? 0))}</p>
                  <p>Abonado {formatCurrency(Number(normalized.paid_amount ?? 0))}</p>
                  <p className="font-semibold">Saldo {formatCurrency(Number(normalized.balance_due ?? 0))}</p>
                </td>
                <td className="px-3 py-3 align-top">
                  <Badge tone={rowStatusTone(row)}>{rowStatusLabel(row)}</Badge>
                </td>
                <td className="px-3 py-3 align-top">
                  {assigned ? <CustomerMini option={assigned} /> : suggested ? <CustomerMini option={suggested} prefix="Sugerido" /> : <span className="text-xs text-black/45">Pendiente de asignación</span>}
                </td>
                <td className="px-3 py-3 align-top">
                  {row.validation_messages.length > 0 ? (
                    <ul className="max-h-28 min-w-72 overflow-auto text-xs text-[#7f1d1d]">
                      {row.validation_messages.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
                    </ul>
                  ) : (
                    <span className="text-xs text-black/45">Sin errores</span>
                  )}
                </td>
                <td className="sticky right-0 border-l border-black/10 bg-white px-3 py-3 align-top">
                  {canResolve ? (
                    <div className="grid min-w-64 gap-2">
                      <div className="flex gap-2">
                        <input
                          value={searchByRow[row.id] ?? ""}
                          onChange={(event) => onSearchChange(row.id, event.target.value)}
                          placeholder="Nombre, correo, teléfono, RTN"
                          className="min-w-0 flex-1 rounded-md border border-black/10 px-2 py-1.5 text-xs"
                        />
                        <button type="button" onClick={() => onSearch(row)} disabled={isPending} className="rounded-md border border-black/10 p-2 hover:bg-[#fff1f2]" aria-label="Buscar cliente">
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
                          <option value="">Seleccionar cliente</option>
                          {rowOptions.map((option) => (
                            <option key={option.id} value={option.id}>{customerOptionText(option)}</option>
                          ))}
                        </select>
                      ) : null}
                      {preview ? <p className="text-xs text-black/55">{preview.reason}</p> : null}
                      <Button type="button" onClick={() => onEditIdentity(row)} disabled={isPending} variant="ghost">
                        <UserRoundPlus size={16} />
                        Completar identidad
                      </Button>
                      {suggested && !assigned ? (
                        <Button type="button" onClick={() => onAssign(row, suggested)} disabled={isPending} variant="ghost">
                          <CheckCircle2 size={16} />
                          Confirmar asignación
                        </Button>
                      ) : null}
                      {canImport && row.apply_status !== "skipped" ? (
                        <Button type="button" onClick={() => onCancel(row.id)} disabled={isPending} variant="ghost">
                          <XCircle size={16} />
                          Cancelar fila
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-xs text-black/45">Sin acción</span>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-3 py-6 text-center text-black/55">Este lote no tiene filas.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      </div>
    </>
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

function CustomerMini({ option, prefix }: { option: AssignmentSelectorOption; prefix?: string }) {
  return (
    <div className="text-xs">
      {prefix ? <p className="font-semibold text-[#92400e]">{prefix}</p> : null}
      <p className="font-semibold">{option.name}</p>
      <p className="text-black/50">{[option.email, option.phone, option.taxId ? `RTN ${option.taxId}` : null].filter(Boolean).join(" | ")}</p>
    </div>
  );
}

function rowStatusLabel(row: ImportRow) {
  if (row.apply_status === "applied") return "Aplicada";
  if (row.apply_status === "rolled_back") return "Revertida";
  if (row.apply_status === "skipped") return "Cancelada";
  if (row.validation_status === "invalid") return "Error";
  if (row.assignment_status === "suggested") return "Pendiente de confirmación";
  if (["pending", "unassigned"].includes(row.assignment_status)) return "Pendiente de asignación";
  if (row.validation_status === "valid" && row.assignment_status === "confirmed") return "Lista para aplicar";
  return "Validada";
}

function rowStatusTone(row: ImportRow): keyof typeof statusBadgeClass {
  const label = rowStatusLabel(row);
  if (label === "Aplicada" || label === "Lista para aplicar" || label === "Validada") return "good";
  if (label === "Error") return "bad";
  if (label === "Pendiente de confirmación" || label === "Pendiente de asignación") return "warn";
  return "neutral";
}

function readyRows(rows: ImportRow[]) {
  return rows.filter((row) => row.validation_status !== "invalid" && row.assignment_status === "confirmed" && ["pending", "ready"].includes(row.apply_status)).length;
}

function customerOptionText(option: AssignmentSelectorOption) {
  return [option.name, option.email, option.phone, option.taxId ? `RTN ${option.taxId}` : null].filter(Boolean).join(" | ");
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function formatDateTime(value: string | null) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-HN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
