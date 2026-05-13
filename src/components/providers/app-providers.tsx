"use client";

import { Suspense } from "react";
import { PriceModeProvider } from "@/contexts/price-mode-context";
import { CartProvider } from "@/contexts/cart-context";
import { OrdersProvider } from "@/contexts/orders-context";
import { ProductRegistryProvider } from "@/contexts/product-registry-context";
import { ToastProvider } from "@/contexts/toast-context";
import { NavigationLoadingOverlay } from "@/components/navigation-loading-overlay";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <PriceModeProvider>
        <ProductRegistryProvider>
          <CartProvider>
            <OrdersProvider>
              {children}
              <Suspense fallback={null}>
                <NavigationLoadingOverlay />
              </Suspense>
            </OrdersProvider>
          </CartProvider>
        </ProductRegistryProvider>
      </PriceModeProvider>
    </ToastProvider>
  );
}
