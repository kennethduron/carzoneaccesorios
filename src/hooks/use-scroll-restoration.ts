"use client";

import { useCallback, useEffect, useRef } from "react";

export function useScrollRestoration<T extends HTMLElement>(storageKey: string, restoreToken?: unknown) {
  const ref = useRef<T | null>(null);

  const saveScroll = useCallback(() => {
    if (typeof window === "undefined") return;
    const node = ref.current;
    if (!node) return;
    window.sessionStorage.setItem(storageKey, String(node.scrollTop));
  }, [storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const node = ref.current;
    if (!node) return;

    const savedValue = Number(window.sessionStorage.getItem(storageKey) ?? 0);
    if (Number.isFinite(savedValue) && savedValue > 0) {
      window.requestAnimationFrame(() => {
        node.scrollTop = savedValue;
      });
    }

    node.addEventListener("scroll", saveScroll, { passive: true });
    return () => node.removeEventListener("scroll", saveScroll);
  }, [restoreToken, saveScroll, storageKey]);

  return [ref, saveScroll] as const;
}
