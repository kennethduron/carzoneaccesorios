"use client";

import { useEffect } from "react";
import { registerDeviceToken, subscribeToForegroundMessages } from "@/lib/firebase/push-client";
import { useToast } from "@/contexts/toast-context";

const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export function PushNotificationRuntime() {
  const toast = useToast();

  useEffect(() => {
    let active = true;
    let cleanupMessages: (() => void) | null = null;

    fetch("/api/admin/push/status", { credentials: "same-origin", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then(async (payload) => {
        if (!active || !payload?.canUsePush || !payload.fcm?.configured || !payload.fcm?.webConfigured) {
          return;
        }

        if (Notification.permission === "granted") {
          const lastSync = window.localStorage.getItem("carzone:fcm:last-sync-at");
          const shouldSync = !lastSync || Date.now() - new Date(lastSync).getTime() > AUTO_SYNC_INTERVAL_MS;
          if (shouldSync) {
            await registerDeviceToken().catch(() => null);
          }
        }

        cleanupMessages = await subscribeToForegroundMessages((payload) => {
          toast.info(payload.notification?.body ?? payload.data?.body ?? "Tienes una nueva notificacion.", {
            title: payload.notification?.title ?? payload.data?.title ?? "Car Zone Accesorios",
            action: payload.data?.url ? { label: "Abrir", href: payload.data.url } : undefined,
          });
        });
      })
      .catch(() => null);

    return () => {
      active = false;
      cleanupMessages?.();
    };
  }, [toast]);

  return null;
}
