"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";

const NOTIFICATION_KEY_PATTERN = /^[a-z0-9:_-]{2,160}$/;

function normalizeNotificationKeys(keys: string[]) {
  return Array.from(
    new Set(
      keys
        .map((key) => key.trim().toLowerCase())
        .filter((key) => NOTIFICATION_KEY_PATTERN.test(key)),
    ),
  ).slice(0, 50);
}

async function markDashboardNotificationKeysRead(keys: string[]) {
  const profile = await requirePermission("admin:access");
  const notificationKeys = normalizeNotificationKeys(keys);

  if (notificationKeys.length === 0) {
    return { ok: false, readKeys: [] as string[] };
  }

  const supabase = await getSupabaseServerClient();
  const now = new Date().toISOString();
  const { error } = await supabase.from("admin_dashboard_notification_reads").upsert(
    notificationKeys.map((notificationKey) => ({
      user_id: profile.id,
      notification_key: notificationKey,
      read_at: now,
      updated_at: now,
    })),
    { onConflict: "user_id,notification_key" },
  );

  if (error) {
    return { ok: false, readKeys: [] as string[] };
  }

  revalidatePath("/admin");
  return { ok: true, readKeys: notificationKeys };
}

export async function markAdminDashboardNotificationReadAction(notificationKey: string) {
  return markDashboardNotificationKeysRead([notificationKey]);
}

export async function markAllAdminDashboardNotificationsReadAction(notificationKeys: string[]) {
  return markDashboardNotificationKeysRead(notificationKeys);
}
