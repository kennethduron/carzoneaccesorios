"use client";

import Link from "next/link";
import { Minus, Plus, Trash2 } from "lucide-react";
import { useShoppingCart } from "@/contexts/cart-context";
import { usePriceMode } from "@/contexts/price-mode-context";
import { formatCurrency } from "@/utils/pricing";

export function CartView() {
  const { rows, cartMessage, subtotal, tax, total, updateQuantity, removeFromCart } = useShoppingCart();
  const { priceMode, wholesaleAccount } = usePriceMode();

  return (
    <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[1fr_360px]">
      <div className="rounded-lg border border-black/10 bg-white">
        <div className="flex flex-col justify-between gap-3 border-b border-black/10 p-5 sm:flex-row sm:items-center">
          <div>
            <h1 className="text-2xl font-semibold">Carrito</h1>
            <p className="mt-1 text-sm text-black/55">
              Precios calculados con {priceMode === "wholesale" ? "wholesale_price" : "retail_price"}.
            </p>
          </div>
          <span className="w-fit rounded-md bg-[#f7f7f2] px-3 py-2 text-sm">
            {priceMode === "wholesale" ? "Modo mayorista" : "Modo retail"}
          </span>
        </div>
        <div className="divide-y divide-black/10">
          {cartMessage ? (
            <div className="border-b border-black/10 bg-[#fff0ea] p-4 text-sm font-medium text-[#9b341b]">
              {cartMessage}
            </div>
          ) : null}
          {rows.length === 0 ? (
            <div className="p-5 text-sm text-black/55">Tu carrito esta vacio.</div>
          ) : (
            rows.map((item) => (
              <div key={item.product.id} className="grid gap-4 p-5 md:grid-cols-[1fr_auto] md:items-center">
                <div>
                  <p className="font-semibold">{item.product.name}</p>
                  <p className="text-sm text-black/50">
                    {item.product.sku} / {formatCurrency(item.unitPrice)} por unidad
                  </p>
                  <p className="mt-1 text-xs text-black/45">
                    Fuente: {priceMode === "wholesale" ? "wholesale_price" : "retail_price"}
                  </p>
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
          <p className="mt-3 rounded-md bg-[#e8f3f2] p-3 text-sm text-[#1e5960]">
            Codigo aplicado: {wholesaleAccount.code}
          </p>
        ) : null}
        <Totals subtotal={subtotal} tax={tax} total={total} />
        <Link
          href="/checkout"
          className="mt-5 inline-flex w-full items-center justify-center rounded-md bg-[#246a73] px-4 py-3 text-sm font-semibold text-white"
        >
          Ir a checkout
        </Link>
      </aside>
    </section>
  );
}

export function Totals({ subtotal, tax, total }: { subtotal: number; tax: number; total: number }) {
  return (
    <div className="mt-4 space-y-2 border-t border-black/10 pt-4 text-sm">
      <div className="flex justify-between">
        <span>Subtotal</span>
        <span>{formatCurrency(subtotal)}</span>
      </div>
      <div className="flex justify-between">
        <span>ISV 15%</span>
        <span>{formatCurrency(tax)}</span>
      </div>
      <div className="flex justify-between text-lg font-semibold">
        <span>Total</span>
        <span>{formatCurrency(total)}</span>
      </div>
    </div>
  );
}
