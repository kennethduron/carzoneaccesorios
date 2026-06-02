import "server-only";

import { getCatalogItem } from "@/lib/notifications/catalog";
import { sendFcmNotification } from "@/lib/notifications/fcm";
import { getSupabaseAdminClient } from "@/lib/supabase";
import type { NotificationModule, NotificationPreference, NotificationSeverity } from "@/types/notifications";

type CreateInternalNotificationInput = {
  type: string;
  title: string;
  message: string;
  severity?: NotificationSeverity;
  module?: NotificationModule;
  userId?: string | null;
  roleName?: string | null;
  orderId?: string | null;
  customerId?: string | null;
  productId?: string | null;
  metadata?: Record<string, unknown>;
  dedupeKey?: string | null;
};

type RecipientRoleInput = {
  type: string;
  fallbackRoles?: string[];
};

export type PreferenceDelivery = {
  preference: NotificationPreference | null;
  internalEnabled: boolean;
  emailEnabled: boolean;
  pushEnabled: boolean;
  destinationRoles: string[];
};

export async function getNotificationPreference(type: string): Promise<NotificationPreference | null> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("notification_preferences")
    .select("*")
    .eq("notification_type", type)
    .maybeSingle<NotificationPreference>();

  if (error) {
    console.warn("Notification preference lookup failed", { type, message: error.message });
    return null;
  }

  return data ?? null;
}

export async function getPreferenceDelivery(input: RecipientRoleInput): Promise<PreferenceDelivery> {
  const catalog = getCatalogItem(input.type);
  const preference = await getNotificationPreference(input.type);
  const destinationRoles =
    preference?.destination_roles?.length
      ? preference.destination_roles
      : input.fallbackRoles?.length
        ? input.fallbackRoles
        : catalog?.defaultRoles ?? [];

  return {
    preference,
    internalEnabled: preference?.internal_enabled ?? true,
    emailEnabled: preference?.email_enabled ?? catalog?.emailDefault ?? false,
    pushEnabled: preference?.push_enabled ?? false,
    destinationRoles,
  };
}

export async function createInternalNotification(input: CreateInternalNotificationInput) {
  const catalog = getCatalogItem(input.type);
  const delivery = await getPreferenceDelivery({ type: input.type, fallbackRoles: input.roleName ? [input.roleName] : undefined });

  if (!delivery.internalEnabled) {
    return { created: false, skipped: true, id: null as string | null };
  }

  const admin = getSupabaseAdminClient();
  const payload = {
    event_type: input.type,
    notification_type: input.type,
    module: input.module ?? catalog?.module ?? "sistema",
    user_id: input.userId ?? null,
    role_name: input.roleName ?? null,
    order_id: input.orderId ?? null,
    customer_id: input.customerId ?? null,
    product_id: input.productId ?? null,
    title: input.title,
    message: input.message,
    severity: input.severity ?? catalog?.defaultSeverity ?? "info",
    audience_roles: delivery.destinationRoles,
    read_state: "unread",
    status: "open",
    metadata: input.metadata ?? {},
    dedupe_key: input.dedupeKey ?? null,
    updated_at: new Date().toISOString(),
  };
  if (input.dedupeKey) {
    const { data: existing, error: existingError } = await admin
      .from("internal_notifications")
      .select("id")
      .eq("dedupe_key", input.dedupeKey)
      .in("status", ["open", "reviewing"])
      .neq("read_state", "archived")
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (existingError) {
      throw new Error(existingError.message);
    }

    if (existing?.id) {
      return { created: false, skipped: false, id: existing.id };
    }
  }

  const { data, error } = await admin.from("internal_notifications").insert(payload).select("id").maybeSingle<{ id: string }>();

  if (error) {
    if (error.code === "23505") {
      return { created: false, skipped: false, id: null as string | null };
    }

    throw new Error(error.message);
  }

  if (data?.id) {
    await admin.from("audit_logs").insert({
      actor_role: "system",
      table_name: "internal_notifications",
      record_id: data.id,
      action: "notification.created",
      new_data: {
        type: input.type,
        module: payload.module,
        dedupe_key: input.dedupeKey ?? null,
      },
    });

    if (delivery.pushEnabled) {
      await sendFcmNotification({
        userIds: input.userId ? [input.userId] : undefined,
        roleNames: input.userId ? undefined : delivery.destinationRoles,
        title: input.title,
        body: input.message,
        data: {
          notification_id: data.id,
          type: input.type,
          module: String(payload.module),
        },
      }).catch((error) => {
        console.warn("FCM notification skipped", { type: input.type, message: error instanceof Error ? error.message : "Unknown" });
      });
    }
  }

  return { created: Boolean(data?.id), skipped: false, id: data?.id ?? null };
}

export async function createTechnicalNotification(input: Omit<CreateInternalNotificationInput, "module" | "roleName">) {
  return createInternalNotification({
    ...input,
    module: "sistema",
    roleName: "technical_owner",
  });
}
