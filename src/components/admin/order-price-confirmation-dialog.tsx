"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui";
import type { OrderPriceAdjustmentPreview, SaleFinancialSnapshot } from "@/types/orders";
import { formatCurrency } from "@/utils/pricing";
import styles from "@/components/admin/admin-orders-responsive.module.css";

export function OrderPriceConfirmationDialog({
  preview,
  processing,
  onBack,
  onConfirm,
}: {
  preview: OrderPriceAdjustmentPreview;
  processing: boolean;
  onBack: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const backButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { backButtonRef.current?.focus(); }, []);

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !processing) {
      event.preventDefault();
      onBack();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), textarea:not([disabled])",
    ) ?? [])];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="cz-layer-modal fixed inset-0 z-[90] flex items-end justify-center bg-black/55 p-2 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-price-confirmation-title"
        aria-describedby="order-price-confirmation-description"
        onKeyDown={keyDown}
        className={`${styles.priceDialogContainer} max-h-[calc(100dvh-1rem)] w-full max-w-6xl overflow-y-auto rounded-xl bg-white shadow-2xl sm:max-h-[calc(100dvh-2rem)]`}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-black/10 bg-white px-4 py-4 sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#0f766e]">{"Autorizaci\u00f3n comercial"}</p>
            <h2 id="order-price-confirmation-title" className="mt-1 text-xl font-semibold sm:text-2xl">Confirmar ajuste de precio</h2>
            <p id="order-price-confirmation-description" className="mt-2 max-w-3xl text-sm text-black/60">
              {"Est\u00e1 a punto de autorizar un cambio en el precio del pedido. Revise la informaci\u00f3n antes de continuar."}
            </p>
          </div>
          <button
            type="button"
            aria-label="No, regresar"
            disabled={processing}
            onClick={onBack}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-black/10 disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </header>

        <div className="space-y-5 p-4 sm:p-6">
          <section aria-labelledby="changed-lines-title">
            <h3 id="changed-lines-title" className="font-semibold">Productos modificados</h3>
            <div className={`${styles.priceDialogCards} mt-3 gap-3`}>
              {preview.lines.map((line) => <LineCard key={line.orderItemId} line={line} />)}
            </div>
            <div className={`${styles.priceDialogTable} mt-3 overflow-x-auto rounded-lg border border-black/10`}>
              <table className="w-full min-w-[1040px] text-left text-sm">
                <thead className="bg-[#f4f4f5] text-xs uppercase text-black/55">
                  <tr>
                    <th className="px-3 py-3">Producto</th><th>SKU</th><th>Cant.</th><th>{"Autom\u00e1tico"}</th>
                    <th>Anterior</th><th>Nuevo</th><th>Dif. unidad</th><th>Dif. total</th><th>Costo</th><th>Margen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {preview.lines.map((line) => (
                    <tr key={line.orderItemId}>
                      <td className="max-w-52 px-3 py-3 font-medium">{line.productName}</td>
                      <td>{line.sku}</td><td>{line.quantity}</td>
                      <td>{formatCurrency(line.automaticUnitPrice)}</td><td>{formatCurrency(line.previousUnitPrice)}</td>
                      <td className="font-semibold">{formatCurrency(line.finalUnitPrice)}</td>
                      <td>{signedCurrency(line.unitDifference)}</td><td>{signedCurrency(line.totalDifference)}</td>
                      <td>{formatCurrency(line.unitCost)}</td><td>{formatCurrency(line.resultingUnitMargin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.lines.some((line) => line.aboveAutomaticPrice) ? (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-[#eff6ff] p-3 text-sm text-[#1e3a8a]">
                <AlertTriangle className="mt-0.5 shrink-0" size={17} />
                {"El nuevo precio es mayor que el precio autom\u00e1tico del producto. Esta advertencia es informativa y no bloquea la autorizaci\u00f3n."}
              </p>
            ) : null}
          </section>

          <section className="grid gap-4 lg:grid-cols-2" aria-label="Comparacion de totales">
            <FinancialCard title="Valores anteriores" financials={preview.previousFinancials} />
            <FinancialCard title="Valores nuevos" financials={preview.nextFinancials} emphasized />
          </section>

          <div className="rounded-lg border border-[#0f766e]/25 bg-[#f0fdfa] p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold">Diferencia total del pedido</span>
              <span className="text-lg font-bold">{signedCurrency(preview.orderTotalDifference)}</span>
            </div>
          </div>

          <label className="block text-sm font-semibold">
            Nota opcional
            <textarea
              value={note}
              maxLength={300}
              disabled={processing}
              onChange={(event) => setNote(event.target.value.replace(/[<>]/g, ""))}
              placeholder={"Ejemplo: precio acordado con el cliente, descuento especial o promoci\u00f3n."}
              className="mt-2 min-h-24 w-full resize-y rounded-lg border border-black/15 px-3 py-2 font-normal outline-none focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/20"
            />
            <span className="mt-1 block text-right text-xs font-normal text-black/45">{note.length}/300</span>
          </label>

          <p className="flex items-start gap-2 text-xs leading-5 text-black/55">
            <CheckCircle2 className="mt-0.5 shrink-0 text-[#0f766e]" size={16} />
            {"La autorizaci\u00f3n registrar\u00e1 actor, rol, fecha, versiones, precios, costo, margen, totales, nota y clave idempotente en auditor\u00eda inmutable."}
          </p>
        </div>

        <footer className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-black/10 bg-white px-4 py-4 sm:flex-row sm:justify-end sm:px-6">
          <button ref={backButtonRef} type="button" disabled={processing} onClick={onBack} className="min-h-11 rounded-md border border-black/10 bg-white px-4 text-sm font-semibold disabled:opacity-50 sm:min-w-40">
            No, regresar
          </button>
          <Button variant="dark" disabled={processing} onClick={() => onConfirm(note.trim())} className="min-h-11 sm:min-w-52">
            {processing ? "Autorizando..." : "S\u00ed, autorizar ajuste"}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function LineCard({ line }: { line: OrderPriceAdjustmentPreview["lines"][number] }) {
  return (
    <article className="rounded-lg border border-black/10 p-3 text-sm">
      <p className="font-semibold">{line.productName}</p>
      <p className="text-xs text-black/50">{line.sku}{" \u00b7 "}{line.quantity} unidad(es)</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
        <Metric label={"Precio autom\u00e1tico"} value={formatCurrency(line.automaticUnitPrice)} />
        <Metric label="Precio anterior" value={formatCurrency(line.previousUnitPrice)} />
        <Metric label="Nuevo precio" value={formatCurrency(line.finalUnitPrice)} strong />
        <Metric label="Diferencia total" value={signedCurrency(line.totalDifference)} />
        <Metric label="Costo unitario" value={formatCurrency(line.unitCost)} />
        <Metric label="Margen resultante" value={formatCurrency(line.resultingUnitMargin)} />
      </dl>
    </article>
  );
}

function Metric({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div><dt className="text-xs text-black/50">{label}</dt><dd className={strong ? "font-semibold" : ""}>{value}</dd></div>;
}

function FinancialCard({ title, financials, emphasized = false }: {
  title: string;
  financials: SaleFinancialSnapshot;
  emphasized?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-4 ${emphasized ? "border-[#0f766e]/30 bg-[#f0fdfa]" : "border-black/10"}`}>
      <h3 className="font-semibold">{title}</h3>
      <dl className="mt-3 space-y-2 text-sm">
        <Row label={"Mercanc\u00eda"} value={financials.merchandise_final} />
        <Row label="Base imponible" value={financials.fiscal_subtotal} />
        <Row label="ISV incluido" value={financials.included_tax_total} />
        <Row label="Entrega" value={financials.delivery_charge} />
        <Row label="Contraentrega" value={financials.cash_on_delivery_charge} />
        <Row label="Otros cargos" value={financials.minimum_order_charge + financials.additional_charges_total} />
        <Row label="Total" value={financials.total_final} strong />
      </dl>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return <div className={`flex items-center justify-between gap-3 ${strong ? "border-t border-black/10 pt-2 font-semibold" : ""}`}><dt>{label}</dt><dd>{formatCurrency(value)}</dd></div>;
}

function signedCurrency(value: number) {
  if (value === 0) return formatCurrency(0);
  return `${value > 0 ? "+" : "\u2212"}${formatCurrency(Math.abs(value))}`;
}
