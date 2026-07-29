import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";

export type CustomerPortalNotification = {
  id: string;
  notification_type: "wholesale_access.approved";
  title: string;
  message: string;
  source: "customer_request" | "admin_direct_grant";
  wholesale_customer_type: "new" | "existing";
  status: "unread" | "read" | "archived";
  toast_pending: boolean;
  toast_shown_at: string | null;
  read_at: string | null;
  created_at: string;
};

export async function getCustomerPortalNotifications(): Promise<CustomerPortalNotification[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("customer_portal_notifications")
    .select("id, notification_type, title, message, source, wholesale_customer_type, status, toast_pending, toast_shown_at, read_at, created_at")
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(30)
    .returns<CustomerPortalNotification[]>();

  if (error) throw new Error("No se pudieron consultar las notificaciones privadas.");
  return data ?? [];
}
