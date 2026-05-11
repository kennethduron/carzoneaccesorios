"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { PriceMode } from "@/types/commerce";
import type { WholesaleAccount } from "@/types/wholesale";

type PriceModeContextValue = {
  priceMode: PriceMode;
  wholesaleAccount: WholesaleAccount | null;
  activateWholesaleMode: (account: WholesaleAccount) => void;
  clearWholesaleMode: () => void;
};

const PriceModeContext = createContext<PriceModeContextValue | null>(null);

export function PriceModeProvider({ children }: { children: React.ReactNode }) {
  const [wholesaleAccount, setWholesaleAccount] = useState<WholesaleAccount | null>(null);

  const value = useMemo<PriceModeContextValue>(() => {
    const priceMode: PriceMode = wholesaleAccount ? "wholesale" : "retail";

    return {
      priceMode,
      wholesaleAccount,
      activateWholesaleMode(account) {
        setWholesaleAccount(account);
      },
      clearWholesaleMode() {
        setWholesaleAccount(null);
      },
    };
  }, [wholesaleAccount]);

  return <PriceModeContext.Provider value={value}>{children}</PriceModeContext.Provider>;
}

export function usePriceMode() {
  const context = useContext(PriceModeContext);

  if (!context) {
    throw new Error("usePriceMode must be used inside PriceModeProvider");
  }

  return context;
}
