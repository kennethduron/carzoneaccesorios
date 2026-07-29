"use client";

import { useState, useTransition } from "react";
import { Bell, Check } from "lucide-react";
import { markCustomerPortalNotificationReadAction } from "@/app/cuenta/actions";
import { Button } from "@/components/ui";
import type { CustomerPortalNotification } from "@/services/supabase/customer-portal-notifications.service";
import { formatHnDateTime } from "@/utils/format";

export function CustomerNotifications({ initialNotifications }: { initialNotifications: CustomerPortalNotification[] }) {
  const [notifications, setNotifications] = useState(initialNotifications);
  const [isPending, startTransition] = useTransition();

  if (notifications.length === 0) return null;

  function markRead(id: string) {
    startTransition(async () => {
      const result = await markCustomerPortalNotificationReadAction(id);
      if (result.ok) {
        setNotifications((current) => current.map((item) => item.id === id ? { ...item, status: "read", read_at: new Date().toISOString() } : item));
      }
    });
  }

  return (
    <section id="notificaciones" className="mt-5 rounded-lg border border-black/10 bg-white p-5 shadow-sm" aria-labelledby="customer-notifications-title">
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-md bg-[#fff1f2] text-[#b91c25]"><Bell size={18} /></div>
        <div><h2 id="customer-notifications-title" className="font-semibold">Notificaciones</h2><p className="text-sm text-black/55">Avisos persistentes de tu cuenta.</p></div>
      </div>
      <div className="mt-4 space-y-3">
        {notifications.map((item) => (
          <article key={item.id} className={`rounded-md border p-4 ${item.status === "unread" ? "border-[#e4252c]/25 bg-[#fffafa]" : "border-black/10 bg-[#f4f4f5]"}`}>
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{item.title}</h3>{item.status === "unread" ? <span className="rounded-full bg-[#e4252c] px-2 py-0.5 text-xs font-semibold text-white">Nueva</span> : null}</div>
                <p className="mt-2 text-sm text-black/65">{item.message}</p>
                <p className="mt-2 text-xs text-black/45">{formatHnDateTime(item.created_at)} · {item.wholesale_customer_type === "existing" ? "Mayorista existente" : "Mayorista nuevo"}</p>
              </div>
              {item.status === "unread" ? <Button type="button" variant="secondary" disabled={isPending} onClick={() => markRead(item.id)} className="min-h-11 shrink-0"><Check size={16} />Marcar como leída</Button> : <span className="text-xs font-semibold text-black/45">Leída</span>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
