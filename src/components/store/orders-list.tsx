"use client";

import Link from "next/link";
import { PackageCheck } from "lucide-react";
import { ContactActions } from "@/components/contact-actions";
import { orderStatusLabels, useOrders } from "@/contexts/orders-context";
import { formatCurrency } from "@/utils/pricing";
import { InvoiceActions } from "@/components/store/invoice-actions";

export function OrdersList() {
  const { orders } = useOrders();

  if (orders.length === 0) {
    return (
      <div className="mt-6 rounded-lg border border-black/10 bg-white p-5">
        <p className="text-sm text-black/60">Tus pedidos apareceran aqui cuando completes compras en la tienda.</p>
        <Link href="/catalogo" className="mt-4 inline-flex rounded-md bg-[#1c1d1b] px-4 py-2 text-sm font-medium text-white">
          Ver catálogo
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-6 grid gap-4">
      {orders.map((order) => {
        const customerPhone = order.customerPhone || order.phone;

        return (
        <article key={order.id} className="rounded-lg border border-black/10 bg-white p-5">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <p className="text-sm text-black/50">{new Date(order.createdAt).toLocaleString("es-HN")}</p>
              <h2 className="mt-1 flex items-center gap-2 text-xl font-semibold">
                <PackageCheck size={20} />
                {order.orderNumber}
              </h2>
              <p className="mt-2 text-sm text-black/60">
                {order.customer.customerName} / {customerPhone}
              </p>
              <ContactActions phone={customerPhone} customerName={order.customer.customerName} className="mt-3" />
            </div>
            <span className="w-fit rounded-md bg-[#e8f3f2] px-3 py-2 text-sm font-medium text-[#1e5960]">
              {orderStatusLabels[order.status]}
            </span>
          </div>
          <div className="mt-4 grid gap-2 text-sm md:grid-cols-3">
            <p>Método: {order.paymentMethod}</p>
            <p>Precio: {order.priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}</p>
            <p className="font-semibold">Total: {formatCurrency(order.total)}</p>
          </div>
          <div className="mt-4 divide-y divide-black/10 rounded-md border border-black/10">
            {order.items.map((item) => (
              <div key={`${order.id}-${item.productId}`} className="flex justify-between gap-3 p-3 text-sm">
                <span>
                  {item.quantity} x {item.name}
                </span>
                <span>{formatCurrency(item.lineTotal)}</span>
              </div>
            ))}
          </div>
          <InvoiceActions order={order} />
        </article>
        );
      })}
    </div>
  );
}
