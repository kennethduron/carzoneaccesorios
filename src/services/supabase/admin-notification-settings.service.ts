import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { NotificationSettings } from "@/types/notifications";

export const defaultNotificationSettings: NotificationSettings = {
  notification_emails: "",
  notify_new_orders: true,
  notify_payment_confirmed: true,
  notify_wholesale_requests: true,
  notify_transfer_receipt_uploaded: true,
  notify_customer_account_created: true,
  notify_low_stock: true,
  send_daily_activity_summary: false,
  send_weekly_sales_summary: false,
};

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("company_settings")
    .select(
      "notification_emails, notify_new_orders, notify_payment_confirmed, notify_wholesale_requests, notify_transfer_receipt_uploaded, notify_customer_account_created, notify_low_stock, send_daily_activity_summary, send_weekly_sales_summary",
    )
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<NotificationSettings>();

  if (error) {
    if (error.code === "42703" || error.message.toLowerCase().includes("notification")) {
      return defaultNotificationSettings;
    }

    throw new Error(error.message);
  }

  return data ?? defaultNotificationSettings;
}

export async function saveNotificationSettings(input: NotificationSettings) {
  const supabase = await getSupabaseServerClient();
  const sanitized: NotificationSettings = {
    notification_emails: input.notification_emails.trim(),
    notify_new_orders: Boolean(input.notify_new_orders),
    notify_payment_confirmed: Boolean(input.notify_payment_confirmed),
    notify_wholesale_requests: Boolean(input.notify_wholesale_requests),
    notify_transfer_receipt_uploaded: Boolean(input.notify_transfer_receipt_uploaded),
    notify_customer_account_created: Boolean(input.notify_customer_account_created),
    notify_low_stock: Boolean(input.notify_low_stock),
    send_daily_activity_summary: Boolean(input.send_daily_activity_summary),
    send_weekly_sales_summary: Boolean(input.send_weekly_sales_summary),
  };

  const { data: existing, error: existingError } = await supabase
    .from("company_settings")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (existingError) {
    throw new Error(existingError.message);
  }

  const query = existing?.id
    ? supabase.from("company_settings").update({ ...sanitized, updated_at: new Date().toISOString() }).eq("id", existing.id)
    : supabase.from("company_settings").insert({ ...sanitized });

  const { error } = await query;

  if (error) {
    throw new Error(error.message);
  }
}
