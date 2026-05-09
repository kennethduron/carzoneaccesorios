"use client";

import { PriceModeProvider } from "@/contexts/price-mode-context";
import { CartProvider } from "@/contexts/cart-context";
import { OrdersProvider } from "@/contexts/orders-context";
import { InvoicesProvider } from "@/contexts/invoices-context";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <PriceModeProvider>
      <CartProvider>
        <OrdersProvider>
          <InvoicesProvider>{children}</InvoicesProvider>
        </OrdersProvider>
      </CartProvider>
    </PriceModeProvider>
  );
}
