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
const storageKey = "car-zone-wholesale-account";

function readStoredWholesaleAccount() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.sessionStorage.getItem(storageKey);
    return stored ? (JSON.parse(stored) as WholesaleAccount) : null;
  } catch {
    window.sessionStorage.removeItem(storageKey);
    return null;
  }
}

function writeStoredWholesaleAccount(account: WholesaleAccount | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (!account) {
    window.sessionStorage.removeItem(storageKey);
    return;
  }

  window.sessionStorage.setItem(storageKey, JSON.stringify(account));
}

export function PriceModeProvider({ children }: { children: React.ReactNode }) {
  const [wholesaleAccount, setWholesaleAccount] = useState<WholesaleAccount | null>(readStoredWholesaleAccount);

  const value = useMemo<PriceModeContextValue>(() => {
    const priceMode: PriceMode = wholesaleAccount ? "wholesale" : "retail";

    return {
      priceMode,
      wholesaleAccount,
      activateWholesaleMode(account) {
        writeStoredWholesaleAccount(account);
        setWholesaleAccount(account);
      },
      clearWholesaleMode() {
        writeStoredWholesaleAccount(null);
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
