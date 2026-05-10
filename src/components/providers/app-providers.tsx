"use client";

import { Suspense } from "react";
import { PriceModeProvider } from "@/contexts/price-mode-context";
import { CartProvider } from "@/contexts/cart-context";
import { OrdersProvider } from "@/contexts/orders-context";
import { InvoicesProvider } from "@/contexts/invoices-context";
import { ProductRegistryProvider } from "@/contexts/product-registry-context";
import { NavigationLoadingOverlay } from "@/components/navigation-loading-overlay";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <PriceModeProvider>
      <ProductRegistryProvider>
        <CartProvider>
          <OrdersProvider>
            <InvoicesProvider>
              {children}
              <Suspense fallback={null}>
                <NavigationLoadingOverlay />
              </Suspense>
            </InvoicesProvider>
          </OrdersProvider>
        </CartProvider>
      </ProductRegistryProvider>
    </PriceModeProvider>
  );
}
