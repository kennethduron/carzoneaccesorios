"use client";

import { Suspense } from "react";
import { PriceModeProvider } from "@/contexts/price-mode-context";
import { AdminPriceViewProvider } from "@/contexts/admin-price-view-context";
import { CartProvider } from "@/contexts/cart-context";
import { OrdersProvider } from "@/contexts/orders-context";
import { ProductRegistryProvider } from "@/contexts/product-registry-context";
import { ToastProvider } from "@/contexts/toast-context";
import { NavigationLoadingOverlay } from "@/components/navigation-loading-overlay";
import type { PortalCommercialContext } from "@/types/portal-commercial";
import type { AdminPriceViewInitialState } from "@/types/admin-price-view";

export function AppProviders({
  children,
  initialCommercialContext,
  initialAdminPriceView,
}: {
  children: React.ReactNode;
  initialCommercialContext: PortalCommercialContext;
  initialAdminPriceView: AdminPriceViewInitialState;
}) {
  return (
    <ToastProvider>
      <AdminPriceViewProvider key={initialAdminPriceView.userId ?? "guest"} initialState={initialAdminPriceView}>
        <PriceModeProvider initialContext={initialCommercialContext}>
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
      </AdminPriceViewProvider>
    </ToastProvider>
  );
}
