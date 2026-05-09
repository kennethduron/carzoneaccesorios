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

const storageKey = "car-zone-price-mode";

const PriceModeContext = createContext<PriceModeContextValue | null>(null);

export function PriceModeProvider({ children }: { children: React.ReactNode }) {
  const [wholesaleAccount, setWholesaleAccount] = useState<WholesaleAccount | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    try {
      const stored = window.sessionStorage.getItem(storageKey);
      if (!stored) {
        return null;
      }

      const parsed = JSON.parse(stored) as WholesaleAccount;
      if (parsed?.status === "active" && parsed.code) {
        return parsed;
      }
    } catch {
      window.sessionStorage.removeItem(storageKey);
    }

    return null;
  });

  const value = useMemo<PriceModeContextValue>(() => {
    const priceMode: PriceMode = wholesaleAccount ? "wholesale" : "retail";

    return {
      priceMode,
      wholesaleAccount,
      activateWholesaleMode(account) {
        setWholesaleAccount(account);
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(storageKey, JSON.stringify(account));
        }
      },
      clearWholesaleMode() {
        setWholesaleAccount(null);
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(storageKey);
        }
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
