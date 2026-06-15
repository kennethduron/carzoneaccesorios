"use client";

import { useEffect } from "react";
import { markCustomerCreditNotificationReadAction } from "@/app/cuenta/actions";
import { useToast } from "@/contexts/toast-context";
import type { CustomerCreditNotification } from "@/services/supabase/credit.service";

export function CustomerCreditNotificationToast({ notifications }: { notifications: CustomerCreditNotification[] }) {
  const toast = useToast();

  useEffect(() => {
    for (const notification of notifications) {
      toast.info("Crédito comercial habilitado. Ahora puedes realizar compras a crédito según las condiciones asignadas.", {
        title: notification.title || "Crédito comercial habilitado",
        duration: 9000,
        action: { label: "Comprar con crédito", href: "/checkout" },
      });
      void markCustomerCreditNotificationReadAction(notification.id);
    }
  }, [notifications, toast]);

  return null;
}
