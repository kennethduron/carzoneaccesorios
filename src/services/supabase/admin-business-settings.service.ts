import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  BacCardStatus,
  BusinessSettings,
  DashboardCardSettings,
  OutOfStockCatalogMode,
  TransferReceiptRequirement,
} from "@/types/settings";
import {
  defaultCommerceSettings,
  defaultDashboardCardSettings,
  defaultInventoryBusinessSettings,
  defaultOrderBusinessSettings,
  defaultWholesaleBusinessSettings,
  normalizeCommerceSettings,
  normalizeDashboardCards,
} from "@/utils/commerce-settings";

type BusinessSettingsRow = Partial<BusinessSettings> & {
  id?: string;
  dashboard_cards?: unknown;
};

export const businessSettingsFields = [
  "free_shipping_threshold",
  "standard_shipping_fee",
  "cash_on_delivery_percentage",
  "enable_cash_on_delivery_fee",
  "first_wholesale_minimum",
  "notification_emails",
  "notify_new_orders",
  "notify_payment_confirmed",
  "notify_transfer_receipt_uploaded",
  "notify_wholesale_requests",
  "notify_customer_account_created",
  "notify_low_stock",
  "send_daily_activity_summary",
  "send_weekly_sales_summary",
  "crm_auto_followup_on_customer_created",
  "crm_auto_followup_after_purchase",
  "crm_show_inactive_customers",
  "crm_detect_duplicates",
  "crm_alert_overdue_followups",
  "wholesale_manual_approval",
  "wholesale_purchases_enabled",
  "wholesale_allow_repeat_without_minimum",
  "wholesale_auto_suspend_inactive",
  "allow_bank_transfer",
  "allow_cash_on_delivery",
  "bac_card_status",
  "send_order_confirmation_email",
  "send_order_status_update_email",
  "require_bank_reference",
  "transfer_receipt_requirement",
  "low_stock_alerts_enabled",
  "global_low_stock_threshold",
  "out_of_stock_catalog_mode",
  "stock_reservations_enabled",
  "stock_reservation_minutes",
  "dashboard_cards",
  "facebook_url",
  "instagram_url",
  "whatsapp_url",
  "tiktok_url",
  "youtube_url",
  "website_url",
  "trade_name",
  "legal_business_name",
  "business_rtn",
  "business_address",
  "customer_service_phone",
  "customer_service_email",
  "customer_service_whatsapp",
  "customer_service_hours",
] as const;

export const defaultBusinessSettings: BusinessSettings = {
  ...defaultCommerceSettings,
  notification_emails: "",
  notify_new_orders: true,
  notify_payment_confirmed: true,
  notify_transfer_receipt_uploaded: true,
  notify_wholesale_requests: true,
  notify_customer_account_created: true,
  notify_low_stock: true,
  send_daily_activity_summary: false,
  send_weekly_sales_summary: false,
  crm_auto_followup_on_customer_created: true,
  crm_auto_followup_after_purchase: true,
  crm_show_inactive_customers: false,
  crm_detect_duplicates: true,
  crm_alert_overdue_followups: true,
  ...defaultWholesaleBusinessSettings,
  ...defaultOrderBusinessSettings,
  ...defaultInventoryBusinessSettings,
  dashboard_cards: defaultDashboardCardSettings,
  facebook_url: "",
  instagram_url: "",
  whatsapp_url: "",
  tiktok_url: "",
  youtube_url: "",
  website_url: "",
  trade_name: "Car Zone Accesorios",
  legal_business_name: "",
  business_rtn: "",
  business_address: "Honduras",
  customer_service_phone: "+504 0000-0000",
  customer_service_email: "ventas@carzoneaccesorios.com",
  customer_service_whatsapp: "",
  customer_service_hours: "Lunes a sábado, 8:00 a.m. a 6:00 p.m.",
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function positiveInteger(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizeBusinessSettings(row: BusinessSettingsRow | null | undefined): BusinessSettings {
  return {
    ...normalizeCommerceSettings(row),
    notification_emails: clean(row?.notification_emails),
    notify_new_orders: row?.notify_new_orders ?? defaultBusinessSettings.notify_new_orders,
    notify_payment_confirmed: row?.notify_payment_confirmed ?? defaultBusinessSettings.notify_payment_confirmed,
    notify_transfer_receipt_uploaded:
      row?.notify_transfer_receipt_uploaded ?? defaultBusinessSettings.notify_transfer_receipt_uploaded,
    notify_wholesale_requests: row?.notify_wholesale_requests ?? defaultBusinessSettings.notify_wholesale_requests,
    notify_customer_account_created:
      row?.notify_customer_account_created ?? defaultBusinessSettings.notify_customer_account_created,
    notify_low_stock: row?.notify_low_stock ?? defaultBusinessSettings.notify_low_stock,
    send_daily_activity_summary: row?.send_daily_activity_summary ?? defaultBusinessSettings.send_daily_activity_summary,
    send_weekly_sales_summary: row?.send_weekly_sales_summary ?? defaultBusinessSettings.send_weekly_sales_summary,
    crm_auto_followup_on_customer_created:
      row?.crm_auto_followup_on_customer_created ?? defaultBusinessSettings.crm_auto_followup_on_customer_created,
    crm_auto_followup_after_purchase:
      row?.crm_auto_followup_after_purchase ?? defaultBusinessSettings.crm_auto_followup_after_purchase,
    crm_show_inactive_customers: row?.crm_show_inactive_customers ?? defaultBusinessSettings.crm_show_inactive_customers,
    crm_detect_duplicates: row?.crm_detect_duplicates ?? defaultBusinessSettings.crm_detect_duplicates,
    crm_alert_overdue_followups: row?.crm_alert_overdue_followups ?? defaultBusinessSettings.crm_alert_overdue_followups,
    wholesale_manual_approval: row?.wholesale_manual_approval ?? defaultBusinessSettings.wholesale_manual_approval,
    wholesale_purchases_enabled: row?.wholesale_purchases_enabled ?? defaultBusinessSettings.wholesale_purchases_enabled,
    wholesale_allow_repeat_without_minimum:
      row?.wholesale_allow_repeat_without_minimum ?? defaultBusinessSettings.wholesale_allow_repeat_without_minimum,
    wholesale_auto_suspend_inactive:
      row?.wholesale_auto_suspend_inactive ?? defaultBusinessSettings.wholesale_auto_suspend_inactive,
    allow_bank_transfer: row?.allow_bank_transfer ?? defaultBusinessSettings.allow_bank_transfer,
    allow_cash_on_delivery: row?.allow_cash_on_delivery ?? defaultBusinessSettings.allow_cash_on_delivery,
    bac_card_status: enumValue<BacCardStatus>(row?.bac_card_status, ["hidden", "pending", "active"], "pending"),
    send_order_confirmation_email:
      row?.send_order_confirmation_email ?? defaultBusinessSettings.send_order_confirmation_email,
    send_order_status_update_email:
      row?.send_order_status_update_email ?? defaultBusinessSettings.send_order_status_update_email,
    require_bank_reference: row?.require_bank_reference ?? defaultBusinessSettings.require_bank_reference,
    transfer_receipt_requirement: enumValue<TransferReceiptRequirement>(
      row?.transfer_receipt_requirement,
      ["disabled", "optional", "required"],
      "optional",
    ),
    low_stock_alerts_enabled: row?.low_stock_alerts_enabled ?? defaultBusinessSettings.low_stock_alerts_enabled,
    global_low_stock_threshold: positiveInteger(
      row?.global_low_stock_threshold,
      defaultBusinessSettings.global_low_stock_threshold,
    ),
    out_of_stock_catalog_mode: enumValue<OutOfStockCatalogMode>(
      row?.out_of_stock_catalog_mode,
      ["show", "hide"],
      "show",
    ),
    stock_reservations_enabled: row?.stock_reservations_enabled ?? defaultBusinessSettings.stock_reservations_enabled,
    stock_reservation_minutes: positiveInteger(
      row?.stock_reservation_minutes,
      defaultBusinessSettings.stock_reservation_minutes,
      15,
      10080,
    ),
    dashboard_cards: normalizeDashboardCards(row?.dashboard_cards) satisfies DashboardCardSettings,
    facebook_url: clean(row?.facebook_url),
    instagram_url: clean(row?.instagram_url),
    whatsapp_url: clean(row?.whatsapp_url),
    tiktok_url: clean(row?.tiktok_url),
    youtube_url: clean(row?.youtube_url),
    website_url: clean(row?.website_url),
    trade_name: clean(row?.trade_name) || defaultBusinessSettings.trade_name,
    legal_business_name: clean(row?.legal_business_name),
    business_rtn: clean(row?.business_rtn),
    business_address: clean(row?.business_address) || defaultBusinessSettings.business_address,
    customer_service_phone: clean(row?.customer_service_phone) || defaultBusinessSettings.customer_service_phone,
    customer_service_email: clean(row?.customer_service_email) || defaultBusinessSettings.customer_service_email,
    customer_service_whatsapp: clean(row?.customer_service_whatsapp),
    customer_service_hours: clean(row?.customer_service_hours) || defaultBusinessSettings.customer_service_hours,
  };
}

export function sanitizeBusinessSettings(input: BusinessSettings): BusinessSettings {
  return normalizeBusinessSettings(input);
}

export async function getAdminBusinessSettings(): Promise<BusinessSettings> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("company_settings")
    .select(businessSettingsFields.join(", "))
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<BusinessSettingsRow>();

  if (error) {
    throw new Error(error.message);
  }

  return normalizeBusinessSettings(data);
}

export async function saveAdminBusinessSettings(input: BusinessSettings) {
  const supabase = await getSupabaseServerClient();
  const sanitized = sanitizeBusinessSettings(input);
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

  return sanitized;
}
