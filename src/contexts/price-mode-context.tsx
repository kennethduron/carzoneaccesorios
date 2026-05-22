"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
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
  const activateWholesaleMode = useCallback((account: WholesaleAccount) => {
    setWholesaleAccount(account);
  }, []);
  const clearWholesaleMode = useCallback(() => {
    setWholesaleAccount(null);
  }, []);

  const value = useMemo<PriceModeContextValue>(() => {
    const priceMode: PriceMode = wholesaleAccount ? "wholesale" : "retail";

    return {
      priceMode,
      wholesaleAccount,
      activateWholesaleMode,
      clearWholesaleMode,
    };
  }, [activateWholesaleMode, clearWholesaleMode, wholesaleAccount]);

  return <PriceModeContext.Provider value={value}>{children}</PriceModeContext.Provider>;
}

export function usePriceMode() {
  const context = useContext(PriceModeContext);

  if (!context) {
    throw new Error("usePriceMode must be used inside PriceModeProvider");
  }

  return context;
}
