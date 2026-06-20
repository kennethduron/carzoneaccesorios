import { getToken, onMessage, type MessagePayload, type Unsubscribe } from "firebase/messaging";
import { getFirebaseMessagingClient, getFirebaseVapidKey, isFirebaseWebConfigured } from "@/lib/firebase/firebase-client";

export type PushPermissionStatus = NotificationPermission | "unsupported";

export type DeviceTokenSyncResult = {
  ok: boolean;
  configured: boolean;
  supported: boolean;
  permission: PushPermissionStatus;
  tokenRegistered: boolean;
  token?: string;
  syncedAt?: string;
  message: string;
};

const LAST_TOKEN_KEY = "carzone:fcm:last-token";
const LAST_SYNC_KEY = "carzone:fcm:last-sync-at";
const TOKEN_SYNCED_EVENT = "carzone:fcm-token-synced";

export function getPermissionStatus(): PushPermissionStatus {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }

  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<PushPermissionStatus> {
  if (getPermissionStatus() === "unsupported") {
    return "unsupported";
  }

  return Notification.requestPermission();
}

export function getLastTokenSyncAt() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem(LAST_SYNC_KEY);
}

async function getServiceWorkerRegistration() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  const existing = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");
  if (existing) {
    return existing;
  }

  return navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
}

export async function refreshDeviceToken() {
  if (!isFirebaseWebConfigured()) {
    return null;
  }

  const permission = getPermissionStatus();
  if (permission !== "granted") {
    return null;
  }

  const messaging = await getFirebaseMessagingClient();
  const registration = await getServiceWorkerRegistration();
  const vapidKey = getFirebaseVapidKey();

  if (!messaging || !registration || !vapidKey) {
    return null;
  }

  return getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
}

export async function registerDeviceToken(): Promise<DeviceTokenSyncResult> {
  const permission = getPermissionStatus();

  if (!isFirebaseWebConfigured()) {
    return {
      ok: false,
      configured: false,
      supported: permission !== "unsupported",
      permission,
      tokenRegistered: false,
      message: "Firebase web push no esta configurado.",
    };
  }

  if (permission !== "granted") {
    return {
      ok: false,
      configured: true,
      supported: permission !== "unsupported",
      permission,
      tokenRegistered: false,
      message: permission === "unsupported" ? "Este navegador no soporta notificaciones." : "Permiso de notificaciones no concedido.",
    };
  }

  const token = await refreshDeviceToken();
  if (!token) {
    return {
      ok: false,
      configured: true,
      supported: true,
      permission,
      tokenRegistered: false,
      message: "No se pudo obtener el token FCM del navegador.",
    };
  }

  const response = await fetch("/api/admin/push/device-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ token, platform: "web" }),
  });
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; message?: string; syncedAt?: string } | null;

  if (!response.ok || !payload?.ok) {
    return {
      ok: false,
      configured: true,
      supported: true,
      permission,
      tokenRegistered: false,
      token,
      message: payload?.message ?? "No se pudo registrar el token FCM.",
    };
  }

  const syncedAt = payload.syncedAt ?? new Date().toISOString();
  window.localStorage.setItem(LAST_TOKEN_KEY, token);
  window.localStorage.setItem(LAST_SYNC_KEY, syncedAt);
  window.dispatchEvent(new CustomEvent(TOKEN_SYNCED_EVENT, { detail: { syncedAt } }));

  return {
    ok: true,
    configured: true,
    supported: true,
    permission,
    tokenRegistered: true,
    token,
    syncedAt,
    message: payload.message ?? "Dispositivo registrado para notificaciones push.",
  };
}

export function subscribeToForegroundMessages(callback: (payload: MessagePayload) => void): Promise<Unsubscribe | null> {
  return getFirebaseMessagingClient().then((messaging) => {
    if (!messaging) {
      return null;
    }

    return onMessage(messaging, callback);
  });
}

export function addTokenSyncedListener(callback: (syncedAt: string | null) => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handler = (event: Event) => {
    callback((event as CustomEvent<{ syncedAt?: string }>).detail?.syncedAt ?? getLastTokenSyncAt());
  };
  window.addEventListener(TOKEN_SYNCED_EVENT, handler);
  return () => window.removeEventListener(TOKEN_SYNCED_EVENT, handler);
}
