import "server-only";

import { createHash, createSign } from "node:crypto";
import { getSupabaseAdminClient } from "@/lib/supabase";

type FcmMessage = {
  userIds?: string[];
  roleNames?: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
};

type FcmTokenRow = {
  id: string;
  token: string;
  user_id: string;
};

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function privateKey() {
  return process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
}

function webConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN &&
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID &&
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET &&
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID &&
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID &&
      process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
  );
}

export function getFcmStatus() {
  const configured = Boolean(
    process.env.FCM_ENABLED === "true" &&
      process.env.FCM_PROJECT_ID &&
      process.env.FCM_CLIENT_EMAIL &&
      privateKey(),
  );

  return {
    enabled: process.env.FCM_ENABLED === "true",
    configured,
    webConfigured: webConfigured(),
    projectId: process.env.FCM_PROJECT_ID ?? null,
  };
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: process.env.FCM_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const signature = base64Url(signer.sign(privateKey()));
  const jwt = `${header}.${claim}.${signature}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const payload = (await response.json().catch(() => null)) as { access_token?: string; error?: string } | null;

  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error || "No se pudo obtener token OAuth para FCM.");
  }

  return payload.access_token;
}

async function getTokensForMessage(input: FcmMessage) {
  const admin = getSupabaseAdminClient();
  const directUserIds = input.userIds ?? [];
  let roleUserIds: string[] = [];

  if (input.roleNames?.length) {
    const { data: roles } = await admin.from("roles").select("id, name").in("name", input.roleNames).returns<Array<{ id: string; name: string }>>();
    const roleIds = (roles ?? []).map((role) => role.id);
    if (roleIds.length) {
      const { data: users } = await admin.from("users").select("id").eq("active", true).in("role_id", roleIds).returns<Array<{ id: string }>>();
      roleUserIds = (users ?? []).map((user) => user.id);
    }
  }

  const userIds = [...new Set([...directUserIds, ...roleUserIds])];
  if (userIds.length === 0) return [];

  const { data, error } = await admin
    .from("fcm_device_tokens")
    .select("id, token, user_id")
    .eq("enabled", true)
    .in("user_id", userIds)
    .returns<FcmTokenRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function registerFcmDeviceToken(input: {
  userId: string;
  token: string;
  platform?: "web" | "android" | "ios" | "unknown";
  userAgent?: string | null;
}) {
  const token = input.token.trim();
  if (!token || createHash("sha256").update(token).digest("hex").length !== 64) {
    return { ok: false, message: "Token FCM inválido." };
  }

  const admin = getSupabaseAdminClient();
  const syncedAt = new Date().toISOString();
  const { error } = await admin.from("fcm_device_tokens").upsert(
    {
      user_id: input.userId,
      token,
      platform: input.platform ?? "web",
      user_agent: input.userAgent ?? null,
      enabled: true,
      invalidated_at: null,
      last_seen_at: syncedAt,
      updated_at: syncedAt,
    },
    { onConflict: "token" },
  );

  if (error) {
    return { ok: false, message: error.message };
  }

  return { ok: true, message: "Dispositivo registrado para notificaciones push.", syncedAt };
}

export async function sendFcmNotification(input: FcmMessage) {
  const status = getFcmStatus();
  if (!status.configured) {
    return { ok: true, enabled: status.enabled, configured: false, sent: 0, failed: 0 };
  }

  const tokens = await getTokensForMessage(input);
  if (tokens.length === 0) {
    return { ok: true, enabled: true, configured: true, sent: 0, failed: 0 };
  }

  const accessToken = await getAccessToken();
  const admin = getSupabaseAdminClient();
  let sent = 0;
  let failed = 0;

  for (const token of tokens) {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${process.env.FCM_PROJECT_ID}/messages:send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: token.token,
          notification: { title: input.title, body: input.body },
          data: input.data ?? {},
        },
      }),
    });

    if (response.ok) {
      sent += 1;
    } else {
      failed += 1;
      const payload = (await response.json().catch(() => null)) as { error?: { status?: string; message?: string } } | null;
      const invalid = ["NOT_FOUND", "INVALID_ARGUMENT"].includes(payload?.error?.status ?? "");
      await admin
        .from("fcm_device_tokens")
        .update({
          enabled: invalid ? false : true,
          invalidated_at: invalid ? new Date().toISOString() : null,
          last_error: payload?.error?.message ?? `FCM status ${response.status}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", token.id);
    }
  }

  return { ok: true, enabled: true, configured: true, sent, failed };
}
