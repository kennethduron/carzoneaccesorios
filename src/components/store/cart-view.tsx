"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Minus, Plus, Trash2 } from "lucide-react";
import { useShoppingCart } from "@/contexts/cart-context";
import { usePriceMode } from "@/contexts/price-mode-context";
import { WholesaleRequirementSummary } from "@/components/store/wholesale-program-info";
import { formatCurrency, getProductPriceLabel, hasValidWholesalePrice } from "@/utils/pricing";
import { calculateCheckoutFees } from "@/utils/commerce-settings";
import { defaultPublicCompanySettings, getPublicCompanySettingsClient } from "@/services/supabase/company-settings-client.service";
import type { PublicCompanySettings } from "@/types/settings";

export function CartView() {
  const { rows, wholesaleQuantityIssues, invalidItemCount, cartMessage, subtotal, tax, updateQuantity, removeFromCart, clearInvalidCartItems } =
    useShoppingCart();
  const { priceMode, wholesaleAccount } = usePriceMode();
  const firstPurchaseRequirement = wholesaleAccount?.firstPurchaseRequirement ?? null;
  const [settings, setSettings] = useState<PublicCompanySettings>(defaultPublicCompanySettings);
  const estimatedFees = useMemo(
    () => calculateCheckoutFees({ subtotal, paymentMethod: "Transferencia bancaria", settings }),
    [settings, subtotal],
  );
  const estimatedTransferTotal = Math.round((subtotal + tax + estimatedFees.shippingFee) * 100) / 100;
  const hasBlockingIssues = invalidItemCount > 0 || wholesaleQuantityIssues.length > 0;

  useEffect(() => {
    let active = true;

    getPublicCompanySettingsClient().then((nextSettings) => {
      if (active) {
        setSettings(nextSettings);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[1fr_360px]">
      <div className="rounded-lg border border-black/10 bg-white">
        <div className="flex flex-col justify-between gap-3 border-b border-black/10 p-5 sm:flex-row sm:items-center">
          <div>
            <h1 className="text-2xl font-semibold">Carrito</h1>
            <p className="mt-1 text-sm text-black/55">
              Precios calculados con {priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}.
            </p>
          </div>
          <span className="w-fit rounded-md bg-[#f4f4f5] px-3 py-2 text-sm">
            {priceMode === "wholesale" ? "Modo mayorista" : "Modo al detalle"}
          </span>
        </div>
        <div className="divide-y divide-black/10">
          {cartMessage ? (
            <div className="border-b border-black/10 bg-[#fff0ea] p-4 text-sm font-medium text-[#9b341b]">
              {cartMessage}
            </div>
          ) : null}
          {invalidItemCount > 0 ? (
            <div className="flex flex-col gap-3 border-b border-black/10 bg-[#fff0ea] p-4 text-sm text-[#9b341b] sm:flex-row sm:items-center sm:justify-between">
              <p className="font-medium">
                Uno de los productos de tu carrito ya no está disponible. Elimínalo y vuelve a intentar.
              </p>
              <button
                type="button"
                onClick={clearInvalidCartItems}
                className="w-fit rounded-md bg-[#9b341b] px-3 py-2 text-sm font-semibold text-white"
              >
                Limpiar carrito
              </button>
            </div>
          ) : null}
          {wholesaleQuantityIssues.length > 0 ? (
            <div className="border-b border-black/10 bg-[#fff0ea] p-4 text-sm text-[#9b341b]">
              <p className="font-semibold">Corrige las cantidades mínimas mayoristas antes de crear el pedido.</p>
              <ul className="mt-2 space-y-1">
                {wholesaleQuantityIssues.map((issue) => (
                  <li key={issue.productId}>
                    {issue.productName}: cantidad mínima mayorista {issue.minimumQuantity} unidades. Actualmente tienes {issue.currentQuantity}.
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {rows.length === 0 ? (
            <div className="p-5 text-sm text-black/55">Tu carrito está vacío.</div>
          ) : (
            rows.map((item) => (
              <div key={item.product.id} className="grid gap-4 p-5 md:grid-cols-[1fr_auto] md:items-center">
                <div>
                  {(() => {
                    const issue = wholesaleQuantityIssues.find((entry) => entry.productId === item.product.id);
                    return issue ? (
                      <div className="mb-3 rounded-md bg-[#fff0ea] p-3 text-sm text-[#9b341b]">
                        <p className="font-semibold">
                          Cantidad mínima mayorista: {issue.minimumQuantity} unidades. Actualmente tienes {issue.currentQuantity}.
                        </p>
                        <button
                          type="button"
                          onClick={() => updateQuantity(item.product.id, issue.minimumQuantity - item.quantity)}
                          className="mt-2 rounded-md bg-[#9b341b] px-3 py-2 text-xs font-semibold text-white"
                        >
                          Aumentar a {issue.minimumQuantity}
                        </button>
                      </div>
                    ) : null;
                  })()}
                  <p className="font-semibold">{item.product.name}</p>
                  <p className="text-sm text-black/50">
                    {item.product.sku} / {formatCurrency(item.unitPrice)} por unidad
                  </p>
                  {priceMode === "wholesale" && item.product.wholesale_min_quantity > 1 ? (
                    <p className="mt-1 text-xs font-medium text-[#9b341b]">
                      Mínimo mayorista: {item.product.wholesale_min_quantity} unidades
                    </p>
                  ) : null}
                  {priceMode === "wholesale" ? (
                    <p className="mt-1 text-xs text-black/45">
                      {hasValidWholesalePrice(item.product)
                        ? "Precio mayorista aplicado"
                        : "Precio disponible aplicado para este producto"}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-black/45">
                      Fuente: {getProductPriceLabel(item.product, priceMode).toLowerCase()}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => updateQuantity(item.product.id, -1)} className="grid size-9 place-items-center rounded-md border border-black/10">
                    <Minus size={15} />
                  </button>
                  <span className="w-8 text-center text-sm">{item.quantity}</span>
                  <button onClick={() => updateQuantity(item.product.id, 1)} className="grid size-9 place-items-center rounded-md border border-black/10">
                    <Plus size={15} />
                  </button>
                  <button onClick={() => removeFromCart(item.product.id)} className="grid size-9 place-items-center rounded-md border border-black/10">
                    <Trash2 size={15} />
                  </button>
                  <span className="w-28 text-right font-semibold">{formatCurrency(item.lineTotal)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <aside className="h-fit rounded-lg border border-black/10 bg-white p-5">
        <h2 className="font-semibold">Resumen</h2>
        {wholesaleAccount ? (
          <p className="mt-3 rounded-md bg-[#fff1f2] p-3 text-sm text-[#b91c25]">
            Cuenta mayorista aprobada: {wholesaleAccount.businessName}
          </p>
        ) : null}
        <Totals subtotal={subtotal} tax={tax} shippingFee={estimatedFees.shippingFee} total={estimatedTransferTotal} settings={settings} />
        {priceMode === "wholesale" &&
        firstPurchaseRequirement &&
        !firstPurchaseRequirement.completed &&
        firstPurchaseRequirement.minimum > 0 ? (
          <WholesaleRequirementSummary requirement={firstPurchaseRequirement} currentFinalTotal={estimatedTransferTotal} className="mt-4" />
        ) : null}
        {hasBlockingIssues ? (
          <button
            type="button"
            disabled
            className="mt-5 inline-flex w-full cursor-not-allowed items-center justify-center rounded-md bg-black/20 px-4 py-3 text-sm font-semibold text-black/45"
          >
            Corrige el carrito
          </button>
        ) : (
          <Link
            href="/checkout"
            className="mt-5 inline-flex w-full items-center justify-center rounded-md bg-[#e4252c] px-4 py-3 text-sm font-semibold text-white"
          >
            Ir a checkout
          </Link>
        )}
      </aside>
    </section>
  );
}

export function Totals({
  subtotal,
  tax,
  shippingFee,
  total,
  settings,
}: {
  subtotal: number;
  tax: number;
  shippingFee: number;
  total: number;
  settings: PublicCompanySettings;
}) {
  const hasFreeShipping = shippingFee === 0 && subtotal >= settings.free_shipping_threshold;

  return (
    <div className="mt-4 space-y-2 border-t border-black/10 pt-4 text-sm">
      <p className="text-xs font-semibold uppercase text-black/50">Resumen financiero</p>
      <div className="flex justify-between">
        <span>Subtotal productos</span>
        <span>{formatCurrency(subtotal)}</span>
      </div>
      <div className="flex justify-between">
        <span>ISV</span>
        <span>{formatCurrency(tax)}</span>
      </div>
      <div className="flex justify-between">
        <span>{hasFreeShipping ? "Envío gratis" : "Envío estándar"}</span>
        <span>{shippingFee === 0 ? "Gratis" : formatCurrency(shippingFee)}</span>
      </div>
      <div className="flex justify-between">
        <span>Contra entrega</span>
        <span>{formatCurrency(0)}</span>
      </div>
      <div className="flex justify-between">
        <span>Recargo pedido mínimo</span>
        <span>{formatCurrency(0)}</span>
      </div>
      <div className="flex justify-between">
        <span>Descuentos</span>
        <span>{formatCurrency(0)}</span>
      </div>
      <div className="flex justify-between">
        <span>Otros cargos</span>
        <span>{formatCurrency(0)}</span>
      </div>
      <div className="rounded-md bg-[#f4f4f5] p-3 text-xs text-black/60">
        <p>Estimado usando transferencia bancaria. En checkout verás el total final a pagar.</p>
      </div>
      <div className="flex justify-between text-lg font-semibold">
        <span>Total estimado</span>
        <span>{formatCurrency(total)}</span>
      </div>
    </div>
  );
}


