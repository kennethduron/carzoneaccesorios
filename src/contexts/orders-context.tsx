"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { CreateOrderInput, OrderStatus, PaymentReviewStatus, StoreOrder } from "@/types/orders";

type OrdersContextValue = {
  orders: StoreOrder[];
  createOrder: (input: CreateOrderInput) => StoreOrder;
  findOrder: (orderNumber: string) => StoreOrder | null;
  updateOrderStatus: (orderNumber: string, status: OrderStatus) => void;
  updatePaymentStatus: (orderNumber: string, status: PaymentReviewStatus) => void;
};

const storageKey = "car-zone-orders";
const OrdersContext = createContext<OrdersContextValue | null>(null);

function readStoredOrders() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = window.sessionStorage.getItem(storageKey);
    const orders = stored ? (JSON.parse(stored) as StoreOrder[]) : [];
    return orders.map((order) => ({
      ...order,
      paymentReference: order.paymentReference ?? order.customer.bankTransferReference ?? null,
      paymentProofFileName: order.paymentProofFileName ?? null,
      paymentStatus: order.paymentStatus ?? "pending_review",
      customerPhone: order.customerPhone ?? order.phone ?? order.customer.phone,
      phone: order.phone ?? order.customerPhone ?? order.customer.phone,
    }));
  } catch {
    window.sessionStorage.removeItem(storageKey);
    return [];
  }
}

function writeStoredOrders(orders: StoreOrder[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(storageKey, JSON.stringify(orders));
}

export const orderStatusLabels: Record<OrderStatus, string> = {
  recibido: "Recibido",
  confirmado: "Confirmado",
  preparacion: "Preparacion",
  empacado: "Empacado",
  enviado: "Enviado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
};

export function OrdersProvider({ children }: { children: React.ReactNode }) {
  const [orders, setOrders] = useState<StoreOrder[]>(readStoredOrders);

  const value = useMemo<OrdersContextValue>(
    () => ({
      orders,
      createOrder(input) {
        const createdAt = new Date().toISOString();
        const order: StoreOrder = {
          ...input,
          id: crypto.randomUUID(),
          orderNumber: `CZ-${Date.now().toString().slice(-8)}`,
          paymentStatus: input.paymentStatus ?? "pending_review",
          customerPhone: input.customerPhone,
          phone: input.phone,
          status: "recibido",
          createdAt,
        };

        setOrders((current) => {
          const nextOrders = [order, ...current];
          writeStoredOrders(nextOrders);
          return nextOrders;
        });

        return order;
      },
      findOrder(orderNumber) {
        const normalized = orderNumber.trim().toUpperCase();
        return orders.find((order) => order.orderNumber.toUpperCase() === normalized) ?? null;
      },
      updateOrderStatus(orderNumber, status) {
        setOrders((current) => {
          const nextOrders = current.map((order) =>
            order.orderNumber === orderNumber ? { ...order, status } : order,
          );
          writeStoredOrders(nextOrders);
          return nextOrders;
        });
      },
      updatePaymentStatus(orderNumber, status) {
        setOrders((current) => {
          const nextOrders = current.map((order) =>
            order.orderNumber === orderNumber ? { ...order, paymentStatus: status } : order,
          );
          writeStoredOrders(nextOrders);
          return nextOrders;
        });
      },
    }),
    [orders],
  );

  return <OrdersContext.Provider value={value}>{children}</OrdersContext.Provider>;
}

export function useOrders() {
  const context = useContext(OrdersContext);

  if (!context) {
    throw new Error("useOrders must be used inside OrdersProvider");
  }

  return context;
}
