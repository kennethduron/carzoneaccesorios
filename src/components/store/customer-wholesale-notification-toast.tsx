"use client";

import { useEffect, useRef } from "react";
import { claimCustomerWholesaleToastAction } from "@/app/cuenta/actions";
import { useToast } from "@/contexts/toast-context";
import type { CustomerPortalNotification } from "@/services/supabase/customer-portal-notifications.service";

export function CustomerWholesaleNotificationToast({ notifications }: { notifications: CustomerPortalNotification[] }) {
  const toast = useToast();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    const pending = notifications.find((item) => item.toast_pending);
    if (!pending) return;

    void claimCustomerWholesaleToastAction(pending.id).then((result) => {
      if (!result.ok || !result.notification) return;
      toast.info(result.notification.message, {
        title: result.notification.title,
        duration: 14000,
        action: { label: "Ver mi cuenta", href: "/cuenta#notificaciones" },
      });
    });
  }, [notifications, toast]);

  return null;
}
