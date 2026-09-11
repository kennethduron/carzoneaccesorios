"use client";

import { createContext, useCallback, useContext, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setAdminPriceViewModeAction } from "@/app/actions/admin-price-view";
import type { AdminPriceViewInitialState, AdminPriceViewMode } from "@/types/admin-price-view";

type AdminPriceViewContextValue = AdminPriceViewInitialState & {
  pendingMode: AdminPriceViewMode | null;
  error: string | null;
  setMode: (mode: AdminPriceViewMode) => void;
};

const AdminPriceViewContext = createContext<AdminPriceViewContextValue | null>(null);

export function AdminPriceViewProvider({
  children,
  initialState,
}: {
  children: React.ReactNode;
  initialState: AdminPriceViewInitialState;
}) {
  const router = useRouter();
  const [mode, setCurrentMode] = useState(initialState.mode);
  const [pendingMode, setPendingMode] = useState<AdminPriceViewMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const setMode = useCallback(
    (nextMode: AdminPriceViewMode) => {
      if (!initialState.eligible || pendingMode || nextMode === mode) return;

      const previousMode = mode;
      setCurrentMode(nextMode);
      setPendingMode(nextMode);
      setError(null);
      startTransition(async () => {
        try {
          const result = await setAdminPriceViewModeAction(nextMode);
          if (!result.ok) {
            setCurrentMode(previousMode);
            setError(result.error);
          } else {
            router.refresh();
          }
        } catch {
          setCurrentMode(previousMode);
          setError("No fue posible guardar la preferencia. Intenta de nuevo.");
        } finally {
          setPendingMode(null);
        }
      });
    },
    [initialState.eligible, mode, pendingMode, router],
  );

  const value = useMemo<AdminPriceViewContextValue>(
    () => ({ ...initialState, mode, pendingMode, error, setMode }),
    [error, initialState, mode, pendingMode, setMode],
  );

  return <AdminPriceViewContext.Provider value={value}>{children}</AdminPriceViewContext.Provider>;
}

export function useAdminPriceView() {
  const context = useContext(AdminPriceViewContext);
  if (!context) throw new Error("useAdminPriceView must be used within AdminPriceViewProvider");
  return context;
}
