"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { CreateInvoiceInput, StoreInvoice } from "@/types/invoices";

type InvoicesContextValue = {
  invoices: StoreInvoice[];
  createInvoice: (input: CreateInvoiceInput) => StoreInvoice;
  findInvoiceByOrder: (orderNumber: string) => StoreInvoice | null;
  cancelInvoice: (invoiceNumber: string) => void;
};

const storageKey = "car-zone-invoices";
const companyRtn = "0801-1999-123456";
const companyCai = "CAI-9C2F8A-4D71B3-2026";
const InvoicesContext = createContext<InvoicesContextValue | null>(null);

function readStoredInvoices() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = window.sessionStorage.getItem(storageKey);
    return stored ? (JSON.parse(stored) as StoreInvoice[]) : [];
  } catch {
    window.sessionStorage.removeItem(storageKey);
    return [];
  }
}

function writeStoredInvoices(invoices: StoreInvoice[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(storageKey, JSON.stringify(invoices));
}

export function InvoicesProvider({ children }: { children: React.ReactNode }) {
  const [invoices, setInvoices] = useState<StoreInvoice[]>(readStoredInvoices);

  const value = useMemo<InvoicesContextValue>(
    () => ({
      invoices,
      createInvoice({ order, customerRtn }) {
        const existing = invoices.find((invoice) => invoice.orderNumber === order.orderNumber);
        if (existing) {
          return existing;
        }

        const issuedAt = new Date().toISOString();
        const invoice: StoreInvoice = {
          id: crypto.randomUUID(),
          invoiceNumber: `CZ-F-${Date.now().toString().slice(-8)}`,
          orderNumber: order.orderNumber,
          rtn: companyRtn,
          cai: companyCai,
          customerName: order.customer.customerName,
          customerRtn: customerRtn?.trim() || null,
          items: order.items,
          subtotal: order.subtotal,
          isv: order.tax,
          total: order.total,
          priceMode: order.priceMode,
          status: "emitida",
          issuedAt,
          cancelledAt: null,
        };

        setInvoices((current) => {
          const nextInvoices = [invoice, ...current];
          writeStoredInvoices(nextInvoices);
          return nextInvoices;
        });

        return invoice;
      },
      findInvoiceByOrder(orderNumber) {
        return invoices.find((invoice) => invoice.orderNumber === orderNumber) ?? null;
      },
      cancelInvoice(invoiceNumber) {
        setInvoices((current) => {
          const nextInvoices = current.map((invoice) =>
            invoice.invoiceNumber === invoiceNumber
              ? { ...invoice, status: "anulada" as const, cancelledAt: new Date().toISOString() }
              : invoice,
          );
          writeStoredInvoices(nextInvoices);
          return nextInvoices;
        });
      },
    }),
    [invoices],
  );

  return <InvoicesContext.Provider value={value}>{children}</InvoicesContext.Provider>;
}

export function useInvoices() {
  const context = useContext(InvoicesContext);

  if (!context) {
    throw new Error("useInvoices must be used inside InvoicesProvider");
  }

  return context;
}
