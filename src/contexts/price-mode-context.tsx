"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { getPortalCommercialContextAction } from "@/app/actions/commercial-context";
import type { PriceMode } from "@/types/commerce";
import {
  createGuestPortalCommercialContext,
  type PortalCommercialContext,
} from "@/types/portal-commercial";
import type { WholesaleAccount } from "@/types/wholesale";

type PriceModeContextValue = {
  priceMode: PriceMode;
  wholesaleAccount: WholesaleAccount | null;
  commercialContext: PortalCommercialContext;
  refreshCommercialContext: () => Promise<PortalCommercialContext>;
  clearCommercialContext: () => void;
};

const PriceModeContext = createContext<PriceModeContextValue | null>(null);

export function PriceModeProvider({
  children,
  initialContext,
}: {
  children: React.ReactNode;
  initialContext: PortalCommercialContext;
}) {
  const [commercialContext, setCommercialContext] = useState(initialContext);

  const refreshCommercialContext = useCallback(async () => {
    const next = await getPortalCommercialContextAction();
    setCommercialContext(next);
    return next;
  }, []);

  const clearCommercialContext = useCallback(() => {
    setCommercialContext(createGuestPortalCommercialContext());
  }, []);

  const value = useMemo<PriceModeContextValue>(() => {
    const priceMode = commercialContext.effectivePriceMode;
    const wholesaleAccount: WholesaleAccount | null =
      priceMode === "wholesale" && commercialContext.customerId
        ? {
            id: commercialContext.customerId,
            customerId: commercialContext.customerId,
            customerName: "Cliente",
            businessName: "Tu cuenta",
            status: "approved",
            customerType: commercialContext.wholesaleCustomerType ?? "new",
            firstPurchaseRequirement: commercialContext.firstPurchaseRequired
              ? {
                  minimum: commercialContext.firstPurchaseMinimum,
                  accumulated: commercialContext.firstPurchaseAccumulated,
                  missing: Math.max(
                    commercialContext.firstPurchaseMinimum -
                      commercialContext.firstPurchaseAccumulated,
                    0,
                  ),
                  completed: commercialContext.firstPurchaseCompleted,
                }
              : null,
          }
        : null;

    return {
      priceMode,
      wholesaleAccount,
      commercialContext,
      refreshCommercialContext,
      clearCommercialContext,
    };
  }, [clearCommercialContext, commercialContext, refreshCommercialContext]);

  return <PriceModeContext.Provider value={value}>{children}</PriceModeContext.Provider>;
}

export function usePriceMode() {
  const context = useContext(PriceModeContext);

  if (!context) {
    throw new Error("usePriceMode must be used inside PriceModeProvider");
  }

  return context;
}
