import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  NotificationPreference,
  NotificationPreferenceUpdate,
  NotificationUserPreference,
  NotificationUserPreferenceUpdate,
} from "@/types/notifications";

export async function getAdminNotificationPreferences(includeTechnical: boolean) {
  const supabase = await getSupabaseServerClient();
  let query = supabase
    .from("notification_preferences")
    .select("*")
    .order("module", { ascending: true })
    .order("notification_type", { ascending: true });

  if (!includeTechnical) {
    query = query.eq("technical_only", false);
  }

  const { data, error } = await query.returns<NotificationPreference[]>();

  if (error) {
    if (error.code === "42P01") {
      return [];
    }

    throw new Error(error.message);
  }

  return data ?? [];
}

export async function getAdminNotificationPreferenceById(id: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("id", id)
    .maybeSingle<NotificationPreference>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

export async function getAdminNotificationPreferenceByType(notificationType: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("notification_type", notificationType)
    .maybeSingle<NotificationPreference>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

export async function saveAdminNotificationPreference(input: NotificationPreferenceUpdate) {
  const supabase = await getSupabaseServerClient();
  const roles = [...new Set(input.destination_roles.map((role) => role.trim()).filter(Boolean))];
  const { data, error } = await supabase
    .from("notification_preferences")
    .update({
      internal_enabled: input.internal_enabled,
      email_enabled: input.email_enabled,
      push_enabled: input.push_enabled,
      destination_roles: roles,
      frequency: input.frequency,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .select("*")
    .single<NotificationPreference>();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function getAdminNotificationUserPreferences(userId: string, includeTechnical: boolean) {
  const supabase = await getSupabaseServerClient();
  const preferences = await getAdminNotificationPreferences(includeTechnical);

  if (preferences.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("notification_user_preferences")
    .select("*")
    .eq("user_id", userId)
    .in(
      "notification_type",
      preferences.map((preference) => preference.notification_type),
    )
    .returns<NotificationUserPreference[]>();

  if (error) {
    if (error.code === "42P01") {
      return [];
    }

    throw new Error(error.message);
  }

  return data ?? [];
}

export async function saveAdminNotificationUserPreference(userId: string, input: NotificationUserPreferenceUpdate) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("notification_user_preferences")
    .upsert(
      {
        user_id: userId,
        notification_type: input.notification_type,
        internal_enabled: input.internal_enabled,
        email_enabled: input.email_enabled,
        push_enabled: input.push_enabled,
        frequency: input.frequency,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,notification_type" },
    )
    .select("*")
    .single<NotificationUserPreference>();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}
