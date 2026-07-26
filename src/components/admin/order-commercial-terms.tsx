"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Calculator, CalendarDays, PackageSearch, Truck } from "lucide-react";
import { adjustSaleTermsAction } from "@/app/admin/pedidos/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AdminOrderRow, DeliveryMode, SaleFinancialSnapshot } from "@/types/orders";
import { formatSqlDateHn, todayInHonduras } from "@/utils/honduras-date";
import { isPaymentConfirmed } from "@/utils/order-workflow";
import { formatCurrency } from "@/utils/pricing";

const deliveryOptions: Array<{ value: DeliveryMode | ""; label: string }> = [
  { value: "", label: "Sin especificar" },
  { value: "car_zone", label: "Entrega de Car Zone" },
  { value: "external_company", label: "Empresa externa" },
  { value: "store_pickup", label: "Retiro en tienda" },
  { value: "customer_arranged", label: "Coordinada por el cliente" },
  { value: "other", label: "Otra modalidad" },
];

function originalUnitPrice(item: AdminOrderRow["order_items"][number]) {
  const value = item.applied_price_mode === "wholesale" ? item.wholesale_price_snapshot : item.retail_price_snapshot;
  return Number(value) > 0 ? Number(value) : null;
}

function moneyInput(value: number) {
  return Number(value).toFixed(2);
}

function initialFinancials(order: AdminOrderRow): SaleFinancialSnapshot {
  const merchandiseGross = order.order_items.reduce((total, item) => total + item.line_total, 0);
  const merchandiseFinal = Math.max(0, merchandiseGross - order.discount_total);
  return {
    merchandise_gross_subtotal: merchandiseGross,
    merchandise_final: merchandiseFinal,
    fiscal_subtotal: order.subtotal,
    included_tax_total: order.tax,
    suggested_delivery_charge: order.shipping_fee_suggested ?? (merchandiseFinal < 3000 ? 120 : 0),
    delivery_charge: order.shipping_fee,
    cash_on_delivery_charge: order.cash_on_delivery_fee,
    minimum_order_charge: order.small_order_fee,
    additional_charges_total: order.additional_fees.reduce((total, fee) => total + fee.amount, 0),
    discount_total: order.discount_total,
    total_final: order.total,
  };
}

function draftSignature(input: {
  date: string;
  prices: Record<string, string>;
  shipping: string;
  mode: DeliveryMode | "";
  provider: string;
  priceReason: string;
  deliveryReason: string;
}) {
  return JSON.stringify(input);
}

export function OrderCommercialTerms({
  order,
  canEdit,
  onDirtyChange,
}: {
  order: AdminOrderRow;
  canEdit: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const today = todayInHonduras();
  const activeInvoice = Boolean(order.invoice_id);
  const monetaryLocked =
    activeInvoice ||
    isPaymentConfirmed(order.payment_status) ||
    ["confirmed", "released", "expired", "canceled"].includes(order.order_reservation_status) ||
    ["paid", "entregado", "delivered", "cancelado", "cancelled"].includes(String(order.status));
  const initialDraft = useMemo(() => ({
    date: order.requested_invoice_date ?? today,
    prices: Object.fromEntries(order.order_items.map((item) => [item.id, moneyInput(item.unit_price)])),
    shipping: moneyInput(order.shipping_fee),
    mode: order.delivery_mode ?? "" as DeliveryMode | "",
    provider: order.external_delivery_provider ?? "",
    priceReason: "",
    deliveryReason: "",
  }), [order, today]);
  const [invoiceDate, setInvoiceDate] = useState(initialDraft.date);
  const [prices, setPrices] = useState<Record<string, string>>(initialDraft.prices);
  const [shippingFee, setShippingFee] = useState(initialDraft.shipping);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode | "">(initialDraft.mode);
  const [externalProvider, setExternalProvider] = useState(initialDraft.provider);
  const [priceReason, setPriceReason] = useState("");
  const [deliveryReason, setDeliveryReason] = useState("");
  const [savedSignature, setSavedSignature] = useState(() => draftSignature(initialDraft));
  const [version, setVersion] = useState(order.commercial_terms_version);
  const [financials, setFinancials] = useState(() => initialFinancials(order));
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [isPending, startTransition] = useTransition();

  const currentDraft = useMemo(() => ({
    date: invoiceDate,
    prices,
    shipping: shippingFee,
    mode: deliveryMode,
    provider: externalProvider,
    priceReason,
    deliveryReason,
  }), [deliveryMode, deliveryReason, externalProvider, invoiceDate, priceReason, prices, shippingFee]);
  const dirty = draftSignature(currentDraft) !== savedSignature;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const clientValidation = useMemo(() => {
    for (const item of order.order_items) {
      const finalPrice = Number(prices[item.id]);
      if (!Number.isFinite(finalPrice) || finalPrice <= 0 || Math.round(finalPrice * 100) !== finalPrice * 100) {
        return "Todos los precios deben ser positivos y tener máximo dos decimales.";
      }
      if (finalPrice !== item.unit_price) {
        if (!item.unit_cost_snapshot || item.unit_cost_snapshot <= 0) {
          return `No se puede ajustar ${item.product_name}: no tiene un costo válido registrado.`;
        }
        if (finalPrice < item.unit_cost_snapshot) {
          return `El precio de ${item.product_name} es inferior a su costo registrado.`;
        }
      }
    }
    const delivery = Number(shippingFee);
    if (!Number.isFinite(delivery) || delivery < 0 || Math.round(delivery * 100) !== delivery * 100) {
      return "El cargo de entrega debe ser no negativo y tener máximo dos decimales.";
    }
    return null;
  }, [order.order_items, prices, shippingFee]);

  function save() {
    if (clientValidation) {
      toast.error(clientValidation);
      return;
    }
    const requestSignature = draftSignature(currentDraft);
    startTransition(async () => {
      const result = await adjustSaleTermsAction({
        orderId: order.id,
        requestedInvoiceDate: invoiceDate,
        linePriceOverrides: order.order_items.map((item) => ({
          orderItemId: item.id,
          finalUnitPrice: Number(prices[item.id]),
        })),
        requestedShippingFee: Number(shippingFee),
        deliveryMode: deliveryMode || null,
        externalDeliveryProvider: externalProvider || null,
        priceReason: priceReason || null,
        deliveryReason: deliveryReason || null,
        expectedVersion: version,
        idempotencyKey,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setVersion(result.snapshot.commercial_terms_version);
      setFinancials(result.snapshot.financials);
      setSavedSignature(requestSignature);
      setIdempotencyKey(crypto.randomUUID());
      toast.success(result.message);
      router.refresh();
    });
  }

  return (
    <section className="min-w-0 rounded-lg border border-[#b91c25]/20 bg-[#fffafa] p-4" aria-labelledby={`commercial-terms-${order.id}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id={`commercial-terms-${order.id}`} className="text-base font-semibold">Ajustes previos a facturación</h3>
          <p className="mt-1 text-sm text-black/60">
            Guarda este snapshot antes de generar la factura. Los cambios quedan en auditoría interna.
          </p>
        </div>
        <span className="self-start rounded-full bg-white px-3 py-1 text-xs font-semibold text-black/55">
          Versión {version}
        </span>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)]">
        <div className="min-w-0 space-y-4">
          <div className="rounded-md border border-black/10 bg-white p-3">
            <div className="flex items-center gap-2 font-semibold"><CalendarDays size={17} /> Fecha de la factura</div>
            {activeInvoice ? (
              <p className="mt-3 text-lg font-semibold">{formatSqlDateHn(order.invoice_date)}</p>
            ) : (
              <Input
                type="date"
                value={invoiceDate}
                max={today}
                disabled={!canEdit || isPending}
                onChange={(event) => setInvoiceDate(event.target.value)}
                className="mt-3 min-h-11"
              />
            )}
            <p className="mt-2 text-xs text-black/55">
              Esta fecha aparecerá en la factura y en los reportes de facturación.
            </p>
          </div>

          <div className="rounded-md border border-black/10 bg-white p-3">
            <div className="flex items-center gap-2 font-semibold"><PackageSearch size={17} /> Precio final por producto</div>
            <div className="mt-3 space-y-3 md:hidden">
              {order.order_items.map((item) => {
                const cost = item.unit_cost_snapshot ? Number(item.unit_cost_snapshot) : null;
                const finalPrice = Number(prices[item.id]);
                const invalidCost = !cost || cost <= 0;
                const belowCost = Boolean(cost && Number.isFinite(finalPrice) && finalPrice < cost);
                return (
                  <article key={item.id} className="rounded-md border border-black/10 p-3">
                    <p className="font-semibold">{item.product_name}</p>
                    <p className="text-xs text-black/50">{item.quantity} unidad(es) · {item.sku}</p>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <Value label="Precio original" value={originalUnitPrice(item) === null ? "No disponible" : formatCurrency(originalUnitPrice(item) ?? 0)} />
                      <Value label="Costo interno" value={cost ? formatCurrency(cost) : "No disponible"} />
                    </div>
                    <label className="mt-3 block text-xs font-medium uppercase text-black/55">
                      Precio final
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={prices[item.id] ?? ""}
                        disabled={!canEdit || monetaryLocked || invalidCost || isPending}
                        onChange={(event) => setPrices((current) => ({ ...current, [item.id]: event.target.value }))}
                        className="mt-1 min-h-11"
                      />
                    </label>
                    <p className={`mt-2 text-xs ${belowCost || invalidCost ? "text-[#b91c25]" : "text-black/55"}`}>
                      {invalidCost ? "Sin costo válido: el precio no puede ajustarse." : belowCost ? "Precio inferior al costo: no se puede guardar." : `Margen estimado: ${formatCurrency((finalPrice - (cost ?? 0)) * item.quantity)}`}
                    </p>
                  </article>
                );
              })}
            </div>
            <div className="mt-3 hidden min-w-0 max-w-full overflow-x-auto md:block">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-black/10 text-xs uppercase text-black/50">
                  <tr><th className="py-2">Producto</th><th>Unidad(es)</th><th>Original</th><th>Costo</th><th>Precio final</th><th>Margen</th></tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {order.order_items.map((item) => {
                    const cost = item.unit_cost_snapshot ? Number(item.unit_cost_snapshot) : null;
                    const finalPrice = Number(prices[item.id]);
                    const invalidCost = !cost || cost <= 0;
                    const belowCost = Boolean(cost && Number.isFinite(finalPrice) && finalPrice < cost);
                    return (
                      <tr key={item.id}>
                        <td className="max-w-60 py-3 pr-3 font-medium">{item.product_name}</td>
                        <td>{item.quantity}</td>
                        <td>{originalUnitPrice(item) === null ? "No disponible" : formatCurrency(originalUnitPrice(item) ?? 0)}</td>
                        <td>{cost ? formatCurrency(cost) : "No disponible"}</td>
                        <td className="w-36 pr-3">
                          <Input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={prices[item.id] ?? ""}
                            disabled={!canEdit || monetaryLocked || invalidCost || isPending}
                            onChange={(event) => setPrices((current) => ({ ...current, [item.id]: event.target.value }))}
                            className="min-h-11"
                          />
                        </td>
                        <td className={belowCost || invalidCost ? "text-[#b91c25]" : ""}>
                          {invalidCost ? "No ajustable" : belowCost ? "Bajo costo" : formatCurrency((finalPrice - (cost ?? 0)) * item.quantity)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <label className="mt-3 block text-xs font-medium uppercase text-black/55">
              Motivo del ajuste de precio (opcional)
              <Input value={priceReason} maxLength={500} disabled={!canEdit || monetaryLocked || isPending} onChange={(event) => setPriceReason(event.target.value)} className="mt-1 min-h-11" />
            </label>
          </div>

          <div className="rounded-md border border-black/10 bg-white p-3">
            <div className="flex items-center gap-2 font-semibold"><Truck size={17} /> Entrega</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Value label="Cargo sugerido" value={formatCurrency(financials.suggested_delivery_charge)} />
              <label className="text-xs font-medium uppercase text-black/55">
                Cargo aplicado
                <Input type="number" min="0" step="0.01" value={shippingFee} disabled={!canEdit || monetaryLocked || isPending} onChange={(event) => setShippingFee(event.target.value)} className="mt-1 min-h-11" />
              </label>
              <label className="text-xs font-medium uppercase text-black/55">
                Modalidad (opcional)
                <select value={deliveryMode} disabled={!canEdit || monetaryLocked || isPending} onChange={(event) => setDeliveryMode(event.target.value as DeliveryMode | "")} className="mt-1 min-h-11 w-full rounded-md border border-black/10 bg-white px-3 text-sm">
                  {deliveryOptions.map((option) => <option key={option.value || "none"} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="text-xs font-medium uppercase text-black/55">
                Empresa externa (opcional)
                <Input value={externalProvider} maxLength={160} disabled={!canEdit || monetaryLocked || deliveryMode !== "external_company" || isPending} onChange={(event) => setExternalProvider(event.target.value)} className="mt-1 min-h-11" />
              </label>
            </div>
            <label className="mt-3 block text-xs font-medium uppercase text-black/55">
              Motivo de entrega (opcional)
              <Input value={deliveryReason} maxLength={500} disabled={!canEdit || monetaryLocked || isPending} onChange={(event) => setDeliveryReason(event.target.value)} className="mt-1 min-h-11" />
            </label>
            {deliveryMode === "external_company" ? (
              <p className="mt-2 text-xs text-black/55">El cobro de la empresa externa no forma parte de la factura, pago ni cuenta por cobrar de Car Zone.</p>
            ) : null}
          </div>
        </div>

        <aside className="h-fit min-w-0 rounded-md border border-black/10 bg-white p-4 xl:sticky xl:top-4">
          <div className="flex items-center gap-2 font-semibold"><Calculator size={17} /> Resumen confirmado</div>
          <dl className="mt-3 space-y-2 text-sm">
            <Summary label="Mercadería" value={financials.merchandise_final} />
            <Summary label="Base" value={financials.fiscal_subtotal} />
            <Summary label="ISV incluido" value={financials.included_tax_total} />
            <Summary label="Entrega" value={financials.delivery_charge} />
            <Summary label="Contra entrega" value={financials.cash_on_delivery_charge} />
            <Summary label="Total" value={financials.total_final} strong />
          </dl>
          {clientValidation ? <p className="mt-3 rounded-md bg-[#fff1f2] p-2 text-xs text-[#9f1239]">{clientValidation}</p> : null}
          {monetaryLocked && !activeInvoice ? <p className="mt-3 text-xs text-black/55">Los importes están bloqueados por el estado operativo; la fecha todavía puede guardarse si no existe factura.</p> : null}
          {!canEdit ? <p className="mt-3 text-xs text-black/55">Solo lectura. Tu rol no puede modificar fecha, precio ni entrega.</p> : null}
          {canEdit && !activeInvoice ? (
            <Button onClick={save} disabled={isPending || !dirty || Boolean(clientValidation)} variant="dark" className="mt-4 min-h-11 w-full">
              {isPending ? "Guardando..." : "Guardar y recalcular"}
            </Button>
          ) : null}
          {dirty ? <p className="mt-2 text-center text-xs font-medium text-[#b91c25]">Hay cambios sin guardar.</p> : null}
        </aside>
      </div>
    </section>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-[#f4f4f5] p-2"><p className="text-xs uppercase text-black/45">{label}</p><p className="mt-1 font-medium">{value}</p></div>;
}

function Summary({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return <div className={`flex items-center justify-between gap-3 ${strong ? "border-t border-black/10 pt-2 text-base font-semibold" : ""}`}><dt>{label}</dt><dd>{formatCurrency(value)}</dd></div>;
}
