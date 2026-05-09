"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { orderStatusLabels, useOrders } from "@/contexts/orders-context";
import { formatCurrency } from "@/utils/pricing";

const statusFlow = [
  "recibido",
  "confirmado",
  "preparacion",
  "empacado",
  "enviado",
  "en_ruta",
  "entregado",
] as const;

export function OrderTracking() {
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);
  const { findOrder } = useOrders();
  const order = searched ? findOrder(query) : null;
  const activeIndex = order ? statusFlow.indexOf(order.status as (typeof statusFlow)[number]) : -1;

  return (
    <form
      className="rounded-lg border border-black/10 bg-white p-5"
      onSubmit={(event) => {
        event.preventDefault();
        setSearched(true);
      }}
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase text-black/50">Numero de pedido</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="CZ-12345678"
          className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
        />
      </label>
      <button className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#246a73] px-4 py-3 text-sm font-semibold text-white">
        <Search size={17} />
        Buscar pedido
      </button>

      {searched && !order ? (
        <p className="mt-4 rounded-md bg-[#fff0ea] p-3 text-sm text-[#9b341b]">No encontramos ese pedido en esta sesion.</p>
      ) : null}

      {order ? (
        <div className="mt-5 space-y-4">
          <div>
            <p className="text-sm text-black/50">{new Date(order.createdAt).toLocaleString("es-HN")}</p>
            <h2 className="text-xl font-semibold">{order.orderNumber}</h2>
            <p className="mt-1 text-sm text-black/60">Total: {formatCurrency(order.total)}</p>
          </div>
          <div className="space-y-2">
            {statusFlow.map((status, index) => (
              <div key={status} className="flex items-center gap-3">
                <span className={`size-3 rounded-full ${index <= activeIndex ? "bg-[#246a73]" : "bg-black/15"}`} />
                <span className={index <= activeIndex ? "font-medium" : "text-black/45"}>
                  {orderStatusLabels[status]}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </form>
  );
}
