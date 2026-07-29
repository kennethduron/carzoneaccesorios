"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  repairLateRecordedSupplierPaymentAction,
  type SupplierPaymentRepairActionResult,
} from "@/app/admin/cuentas-por-pagar/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SupplierPaymentAccountingRepairPreview } from "@/types/supplier-payment-accounting-repair";

type Props = {
  previews: SupplierPaymentAccountingRepairPreview[];
  canRepair: boolean;
};

const classificationLabels: Record<
  SupplierPaymentAccountingRepairPreview["classification"],
  string
> = {
  eligible_late_recorded: "Contabilidad pendiente",
  already_accounted: "Contabilizado o en proceso",
  modern_missing_outbox: "Pago moderno pendiente",
  historical_before_cutover: "Revisión histórica",
  mapping_missing: "Mapping pendiente",
  chronology_conflict: "Conflicto de cronología",
  invalid_payment: "Pago no válido",
  cancelled_or_reversed: "Anulado o revertido",
  review_required: "Revisión requerida",
};

function formatCurrency(amount: number, currency = "HNL") {
  return new Intl.NumberFormat("es-HN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatDate(value: string | null, includeTime = false) {
  if (!value) return "No disponible";
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T12:00:00-06:00`
    : value;
  return new Intl.DateTimeFormat("es-HN", {
    timeZone: "America/Tegucigalpa",
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(includeTime
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {}),
  }).format(new Date(normalized));
}

function accountingHref(journalEntryId: string) {
  return `/admin/contabilidad?journal_entry_id=${encodeURIComponent(journalEntryId)}`;
}

export function SupplierPaymentAccountingRepairPanel({
  previews,
  canRepair,
}: Props) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [reason, setReason] = useState("Recuperación de pago ingresado después del corte");
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<SupplierPaymentRepairActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const visiblePreviews = useMemo(
    () =>
      previews.filter((preview) =>
        [
          "eligible_late_recorded",
          "already_accounted",
          "mapping_missing",
          "chronology_conflict",
          "review_required",
        ].includes(preview.classification),
      ),
    [previews],
  );

  function beginRepair(preview: SupplierPaymentAccountingRepairPreview) {
    setResult(null);
    setConfirmed(false);
    setConfirmingId(preview.payment_id);
  }

  function executeRepair(preview: SupplierPaymentAccountingRepairPreview) {
    if (!confirmed || isPending) return;
    startTransition(async () => {
      const actionResult = await repairLateRecordedSupplierPaymentAction({
        request_key: globalThis.crypto.randomUUID(),
        payment_id: preview.payment_id,
        expected_fingerprint: preview.expected_fingerprint,
        reason,
      });
      setResult(actionResult);
      if (actionResult.ok) router.refresh();
    });
  }

  if (visiblePreviews.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="supplier-payment-accounting-repair-title"
      className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="text-amber-700" size={20} />
            <h2
              id="supplier-payment-accounting-repair-title"
              className="font-semibold text-stone-950"
            >
              Seguimiento contable de pagos ingresados posteriormente
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-stone-600">
            Conserva la fecha efectiva y propone la fecha del registro en el
            sistema para el borrador. La publicación siempre requiere revisión
            manual.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          disabled={isPending}
          onClick={() => router.refresh()}
        >
          <RefreshCw size={16} />
          Actualizar vista previa
        </Button>
      </div>

      <div className="mt-4 grid gap-3">
        {visiblePreviews.map((preview) => {
          const expanded = expandedId === preview.payment_id;
          const confirming = confirmingId === preview.payment_id;
          const eligible = preview.classification === "eligible_late_recorded";
          const journalId =
            preview.existing_journal?.id ??
            (result?.ok ? result.result.journal_entry_id : null);

          return (
            <article
              key={preview.payment_id}
              className="rounded-lg border border-black/10 bg-white p-4"
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="grid gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-stone-950">
                      {preview.supplier_name}
                    </p>
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                      {classificationLabels[preview.classification]}
                    </span>
                  </div>
                  <p className="text-sm text-stone-600">
                    {preview.payment_reference} ·{" "}
                    {formatCurrency(preview.amount, preview.currency)}
                  </p>
                  <div className="grid gap-1 text-sm text-stone-700 sm:grid-cols-3 sm:gap-4">
                    <p>
                      <span className="block text-xs text-stone-500">
                        Fecha efectiva
                      </span>
                      {formatDate(preview.effective_paid_at)}
                    </p>
                    <p>
                      <span className="block text-xs text-stone-500">
                        Registrado en el sistema
                      </span>
                      {formatDate(preview.recorded_at, true)}
                    </p>
                    <p>
                      <span className="block text-xs text-stone-500">
                        Fecha propuesta del borrador
                      </span>
                      {formatDate(preview.proposed_journal_date)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      setExpandedId(expanded ? null : preview.payment_id)
                    }
                  >
                    {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    {expanded ? "Ocultar validaciones" : "Ver vista previa"}
                  </Button>
                  {canRepair && eligible ? (
                    <Button
                      type="button"
                      disabled={isPending}
                      onClick={() => beginRepair(preview)}
                    >
                      Ejecutar reparación individual
                    </Button>
                  ) : null}
                  {journalId ? (
                    <Link
                      href={accountingHref(journalId)}
                      className="inline-flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-semibold"
                    >
                      Ir al borrador contable
                      <ExternalLink size={15} />
                    </Link>
                  ) : null}
                </div>
              </div>

              {expanded ? (
                <div className="mt-4 grid gap-4 border-t border-black/10 pt-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    {preview.preview_lines.map((line) => (
                      <div
                        key={line.side}
                        className="rounded-lg bg-stone-50 p-3 text-sm"
                      >
                        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                          {line.side === "debit" ? "Débito" : "Crédito"}
                        </p>
                        <p className="mt-1 font-semibold text-stone-950">
                          {line.account_code ?? "Sin mapping"} —{" "}
                          {line.account_name ?? "Cuenta no disponible"}
                        </p>
                        <p className="mt-1">
                          {formatCurrency(line.amount, preview.currency)}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="grid gap-2 text-sm text-stone-700 sm:grid-cols-2 lg:grid-cols-4">
                    <p>
                      <span className="block text-xs text-stone-500">Obligación</span>
                      {preview.accounts_payable_reference}
                    </p>
                    <p>
                      <span className="block text-xs text-stone-500">
                        Reconocimiento CxP
                      </span>
                      {preview.payable_recognition
                        ? `${preview.payable_recognition.entry_number} · ${formatDate(preview.payable_recognition.entry_date)}`
                        : "No identificado"}
                    </p>
                    <p>
                      <span className="block text-xs text-stone-500">Método</span>
                      {preview.payment_method ?? "No disponible"}
                    </p>
                    <p>
                      <span className="block text-xs text-stone-500">Balance</span>
                      {preview.balanced ? "Débitos = créditos" : "Revisión requerida"}
                    </p>
                  </div>
                  <p className="flex items-center gap-2 rounded-md bg-blue-50 p-3 text-sm text-blue-900">
                    <CheckCircle2 size={17} />
                    Publicación manual obligatoria. La vista previa no crea
                    eventos, outboxes ni partidas.
                  </p>
                </div>
              ) : null}

              {confirming ? (
                <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 text-amber-700" size={18} />
                    <div>
                      <p className="font-semibold">Confirmar reparación individual</p>
                      <p className="mt-1 text-sm text-stone-700">
                        {preview.supplier_name} ·{" "}
                        {formatCurrency(preview.amount, preview.currency)} ·
                        efectiva {formatDate(preview.effective_paid_at)} ·
                        registrada {formatDate(preview.recorded_at, true)} ·
                        borrador propuesto {formatDate(preview.proposed_journal_date)}.
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3">
                    <label className="grid gap-1 text-sm font-medium">
                      Motivo
                      <Input
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        maxLength={500}
                        disabled={isPending}
                      />
                    </label>
                    <label className="flex items-start gap-2 text-sm text-stone-700">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                        disabled={isPending}
                        className="mt-1"
                      />
                      Confirmo los débitos y créditos mostrados y entiendo que
                      la partida quedará en borrador, sin publicación automática.
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        disabled={!confirmed || isPending || reason.trim().length < 8}
                        onClick={() => executeRepair(preview)}
                      >
                        {isPending ? "Procesando…" : "Enviar al procesamiento contable"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={isPending}
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {result ? (
        <p
          role="status"
          className={`mt-4 rounded-md p-3 text-sm ${
            result.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-900"
          }`}
        >
          {result.message}
        </p>
      ) : null}
    </section>
  );
}
