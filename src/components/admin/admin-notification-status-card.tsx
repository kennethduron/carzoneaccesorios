"use client";

import { useEffect, useState } from "react";
import { BellRing, CheckCircle2, Clock, TriangleAlert, XCircle } from "lucide-react";
import { addTokenSyncedListener, getPermissionStatus } from "@/lib/firebase/push-client";

type PushStatusPayload = {
  fcm: {
    enabled: boolean;
    configured: boolean;
    webConfigured: boolean;
    projectId: string | null;
  };
  device: {
    registered: boolean;
    tokenCount: number;
    lastSyncAt: string | null;
  };
  summary: {
    registeredTokens: number;
  } | null;
};

function formatDate(value: string | null) {
  if (!value) return "Sin sincronizacion";

  return new Intl.DateTimeFormat("es-HN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusLabel(payload: PushStatusPayload | null, permission: NotificationPermission | "unsupported") {
  if (!payload?.fcm.configured || !payload.fcm.webConfigured) {
    return { label: "No configuradas", tone: "bg-[#fff7ed] text-[#7c2d12]", icon: TriangleAlert };
  }

  if (permission === "denied") {
    return { label: "Bloqueadas", tone: "bg-[#fdecec] text-[#a33a2d]", icon: XCircle };
  }

  if (payload.device.registered && permission === "granted") {
    return { label: "Activadas", tone: "bg-[#edf7ed] text-[#2f6f3e]", icon: CheckCircle2 };
  }

  return { label: "Desactivadas", tone: "bg-[#f4f4f5] text-black/55", icon: BellRing };
}

export function AdminNotificationStatusCard() {
  const [payload, setPayload] = useState<PushStatusPayload | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");

  useEffect(() => {
    let active = true;

    function refresh() {
      setPermission(getPermissionStatus());
      fetch("/api/admin/push/status", { credentials: "same-origin", cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (active) setPayload(data ?? null);
        })
        .catch(() => {
          if (active) setPayload(null);
        });
    }

    refresh();
    const removeTokenListener = addTokenSyncedListener(refresh);

    return () => {
      active = false;
      removeTokenListener();
    };
  }, []);

  const status = statusLabel(payload, permission);
  const Icon = status.icon;

  return (
    <section className="mb-4 rounded-lg border border-black/10 bg-white p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-black/50">Estado de Notificaciones</p>
          <h2 className="text-xl font-semibold">Push administrativo</h2>
        </div>
        <span className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${status.tone}`}>
          <Icon size={14} />
          {status.label}
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Push" value={payload?.device.registered && permission === "granted" ? "Activado" : "Desactivado"} />
        <Metric label="Tokens registrados" value={(payload?.summary?.registeredTokens ?? 0).toLocaleString("es-HN")} />
        <Metric label="Ultima sincronizacion" value={formatDate(payload?.device.lastSyncAt ?? null)} />
        <Metric label="Estado FCM" value={payload?.fcm.configured && payload.fcm.webConfigured ? "Configurado" : "No configurado"} />
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-black/45">
        <Clock size={13} />
        Permiso del navegador: {permission}
      </p>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-black/10 bg-[#fafafa] p-3">
      <p className="text-xs uppercase text-black/45">{label}</p>
      <p className="mt-1 break-words font-semibold">{value}</p>
    </div>
  );
}
