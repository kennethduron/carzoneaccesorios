"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { SystemLoadingScreen } from "@/components/system-loading-screen";

export function NavigationLoadingOverlay() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = `${pathname}?${searchParams.toString()}`;
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function isDownloadHref(anchor: HTMLAnchorElement, url: URL) {
      if (anchor.hasAttribute("download")) {
        return true;
      }

      if (url.pathname.startsWith("/api/")) {
        return true;
      }

      return /\.(csv|pdf|xls|xlsx|zip|txt)$/i.test(url.pathname);
    }

    function clearPendingOverlay() {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }

    function finishNavigation() {
      clearPendingOverlay();
      setVisible(false);
    }

    function handleClick(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target.closest("a") : null;
      if (!(target instanceof HTMLAnchorElement)) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || target.target === "_blank") {
        return;
      }

      const href = target.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
        return;
      }

      const currentUrl = new URL(window.location.href);
      const nextUrl = new URL(target.href);
      if (nextUrl.origin !== currentUrl.origin || nextUrl.href === currentUrl.href) {
        return;
      }

      if (nextUrl.pathname === currentUrl.pathname && nextUrl.search === currentUrl.search) {
        return;
      }

      if (isDownloadHref(target, nextUrl)) {
        return;
      }

      clearPendingOverlay();
      const sourceRouteKey = `${currentUrl.pathname}?${currentUrl.searchParams.toString()}`;
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        const browserUrl = new URL(window.location.href);
        const browserRouteKey = `${browserUrl.pathname}?${browserUrl.searchParams.toString()}`;
        if (browserRouteKey === sourceRouteKey) return;
        setVisible(true);
      }, 220);
    }

    document.addEventListener("click", handleClick, true);
    window.addEventListener("hashchange", finishNavigation);
    window.addEventListener("pageshow", finishNavigation);
    window.addEventListener("popstate", finishNavigation);
    return () => {
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("hashchange", finishNavigation);
      window.removeEventListener("pageshow", finishNavigation);
      window.removeEventListener("popstate", finishNavigation);
      clearPendingOverlay();
    };
  }, []);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    const hideTimer = setTimeout(() => setVisible(false), 0);
    return () => clearTimeout(hideTimer);
  }, [routeKey]);

  return visible ? <SystemLoadingScreen fullScreen /> : null;
}
