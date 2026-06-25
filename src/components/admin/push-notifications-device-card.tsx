"use client";

import { useEffect, useState } from "react";
import { BellRing, CheckCircle2, TriangleAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import {
  addTokenSyncedListener,
  getLastTokenSyncAt,
  getPermissionStatus,
  registerDeviceToken,
  requestNotificationPermission,
} from "@/lib/firebase/push-client";

type FcmStatus = {
  enabled: boolean;
  configured: boolean;
  webConfigured: boolean;
  projectId: string | null;
};

type DeviceStatus = {
  registered: boolean;
  tokenCount: number;
  lastSyncAt: string | null;
};

export function PushNotificationsDeviceCard() {
  const [status, setStatus] = useState<FcmStatus | null>(null);
  const [device, setDevice] = useState<DeviceStatus | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let active = true;

    function refreshStatus() {
      setPermission(getPermissionStatus());
      fetch("/api/admin/push/status", { credentials: "same-origin", cache: "no-store" })
        .then((response) => response.json())
        .then((payload) => {
          if (!active) return;
          setStatus(payload.fcm ?? null);
          setDevice(payload.device ?? null);
        })
        .catch(() => {
          if (!active) return;
          setStatus({ enabled: false, configured: false, webConfigured: false, projectId: null });
          setDevice(null);
        });
    }

    refreshStatus();
    const removeTokenListener = addTokenSyncedListener(refreshStatus);

    return () => {
      active = false;
      removeTokenListener();
    };
  }, []);

  async function requestPush() {
    if (!status?.configured || !status.webConfigured) {
      toast.warning("Firebase Cloud Messaging todavía no está configurado.");
      return;
    }

    if (getPermissionStatus() === "unsupported") {
      toast.error("Este navegador no admite notificaciones.");
      return;
    }

    setLoading(true);
    try {
      const nextPermission = await requestNotificationPermission();
      setPermission(nextPermission);

      if (nextPermission !== "granted") {
        toast.warning("Permiso de notificaciones no concedido.");
        return;
      }

      const result = await registerDeviceToken();
      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      setDevice((current) => ({
        registered: true,
        tokenCount: Math.max(current?.tokenCount ?? 0, 1),
        lastSyncAt: result.syncedAt ?? new Date().toISOString(),
      }));
      toast.success("Notificaciones activadas en este dispositivo.");
    } finally {
      setLoading(false);
    }
  }

  const display = statusDisplay(status, permission, device);

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
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <StatusPill label="Estado" value={display.label} tone={display.tone} icon={display.icon} />
            <StatusItem label="Permiso" value={browserPermissionLabel(permission)} />
            <StatusItem label="Token registrado" value={device?.registered ? "Sí" : "No"} />
            <StatusItem label="Última sincronización" value={formatDate(device?.lastSyncAt ?? getLastTokenSyncAt())} />
          </div>
          <div className="mt-3">
            <Button onClick={requestPush} disabled={loading} variant="dark">
              <BellRing size={16} />
              {loading ? "Solicitando..." : "Activar notificaciones"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function statusDisplay(status: FcmStatus | null, permission: NotificationPermission | "unsupported", device: DeviceStatus | null) {
  if (!status?.configured || !status.webConfigured) {
    return { label: "No configuradas", tone: "bg-[#fff7ed] text-[#7c2d12]", icon: TriangleAlert };
  }

  if (permission === "denied") {
    return { label: "Bloqueadas", tone: "bg-[#fdecec] text-[#a33a2d]", icon: XCircle };
  }

  if (permission === "granted" && device?.registered) {
    return { label: "Activadas", tone: "bg-[#edf7ed] text-[#2f6f3e]", icon: CheckCircle2 };
  }

  return { label: "Desactivadas", tone: "bg-[#f4f4f5] text-black/55", icon: BellRing };
}

function browserPermissionLabel(permission: NotificationPermission | "unsupported") {
  if (permission === "granted") return "Concedido";
  if (permission === "denied") return "Bloqueado";
  if (permission === "default") return "No solicitado";
  return "No compatible";
}

function formatDate(value: string | null) {
  if (!value) return "Sin sincronización";

  return new Intl.DateTimeFormat("es-HN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-black/10 bg-[#fafafa] p-2.5">
      <p className="text-xs uppercase text-black/45">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold">{value}</p>
    </div>
  );
}

function StatusPill({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  tone: string;
  icon: typeof BellRing;
}) {
  return (
    <div className="rounded-md border border-black/10 bg-[#fafafa] p-2.5">
      <p className="text-xs uppercase text-black/45">{label}</p>
      <span className={`mt-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>
        <Icon size={14} />
        {value}
      </span>
    </div>
  );
}
