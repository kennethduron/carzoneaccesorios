"use client";

import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";

type FcmStatus = {
  enabled: boolean;
  configured: boolean;
  projectId: string | null;
};

export function PushNotificationsDeviceCard() {
  const [status, setStatus] = useState<FcmStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let active = true;
    fetch("/api/admin/push/status")
      .then((response) => response.json())
      .then((payload) => {
        if (active) setStatus(payload.fcm ?? null);
      })
      .catch(() => {
        if (active) setStatus({ enabled: false, configured: false, projectId: null });
      });

    return () => {
      active = false;
    };
  }, []);

  async function requestPush() {
    if (!status?.configured) {
      toast.warning("Firebase Cloud Messaging todavía no está configurado.");
      return;
    }

    if (!("Notification" in window)) {
      toast.error("Este navegador no soporta notificaciones.");
      return;
    }

    setLoading(true);
    const permission = await Notification.requestPermission();
    setLoading(false);

    if (permission !== "granted") {
      toast.warning("Permiso de notificaciones no concedido.");
      return;
    }

    toast.success("Permiso concedido. El token FCM se registrará cuando se agregue la configuración web del cliente.");
  }

  return (
    <section className="rounded-lg border border-black/10 bg-white p-5">
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-[#fff1f2] text-[#b91c25]">
          <BellRing size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Notificaciones en este dispositivo</h2>
          <p className="mt-1 text-sm text-black/55">
            Firebase Cloud Messaging queda listo para CRM/admin cuando se configuren las credenciales.
          </p>
          <p className="mt-2 text-xs text-black/45">
            Estado: {status?.configured ? "configurado" : status?.enabled ? "habilitado sin credenciales completas" : "deshabilitado"}.
          </p>
          <div className="mt-3">
            <Button onClick={requestPush} disabled={loading} variant="dark">
              <BellRing size={16} />
              {loading ? "Solicitando..." : "Activar notificaciones en este dispositivo"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
