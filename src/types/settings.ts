export type CommerceSettings = {
  free_shipping_threshold: number;
  standard_shipping_fee: number;
  cash_on_delivery_percentage: number;
  enable_cash_on_delivery_fee: boolean;
  first_wholesale_minimum: number;
};

export type BacCardStatus = "hidden" | "pending" | "active";
export type TransferReceiptRequirement = "disabled" | "optional" | "required";
export type OutOfStockCatalogMode = "show" | "hide";

export type DashboardCardKey =
  | "sales_today"
  | "pending_orders"
  | "pending_payments"
  | "low_inventory"
  | "wholesale_requests"
  | "customers_attention"
  | "pending_invoices"
  | "bac_alerts"
  | "backup_cron_status";

export type DashboardCardSettings = Record<DashboardCardKey, boolean>;

export type BusinessNotificationSettings = {
  notification_emails: string;
  notify_new_orders: boolean;
  notify_payment_confirmed: boolean;
  notify_transfer_receipt_uploaded: boolean;
  notify_wholesale_requests: boolean;
  notify_customer_account_created: boolean;
  notify_low_stock: boolean;
  send_daily_activity_summary: boolean;
  send_weekly_sales_summary: boolean;
};

export type CrmBusinessSettings = {
  crm_auto_followup_on_customer_created: boolean;
  crm_auto_followup_after_purchase: boolean;
  crm_show_inactive_customers: boolean;
  crm_detect_duplicates: boolean;
  crm_alert_overdue_followups: boolean;
};

export type WholesaleBusinessSettings = {
  wholesale_manual_approval: boolean;
  wholesale_purchases_enabled: boolean;
  wholesale_allow_repeat_without_minimum: boolean;
  wholesale_auto_suspend_inactive: boolean;
};

export type OrderBusinessSettings = {
  allow_bank_transfer: boolean;
  allow_cash_on_delivery: boolean;
  bac_card_status: BacCardStatus;
  send_order_confirmation_email: boolean;
  send_order_status_update_email: boolean;
  require_bank_reference: boolean;
  transfer_receipt_requirement: TransferReceiptRequirement;
};

export type InventoryBusinessSettings = {
  low_stock_alerts_enabled: boolean;
  global_low_stock_threshold: number;
  out_of_stock_catalog_mode: OutOfStockCatalogMode;
  stock_reservations_enabled: boolean;
  stock_reservation_minutes: number;
};

export type SocialSettings = {
  facebook_url: string;
  instagram_url: string;
  whatsapp_url: string;
  tiktok_url: string;
  youtube_url: string;
  website_url: string;
};

export type BusinessContactSettings = {
  trade_name: string;
  legal_business_name: string;
  business_rtn: string;
  business_address: string;
  customer_service_phone: string;
  customer_service_email: string;
  customer_service_whatsapp: string;
  customer_service_hours: string;
};

export type PublicCompanySettings = CommerceSettings &
  SocialSettings & {
    company_name: string;
    currency: string;
    tax_rate: number;
    logo_url: string | null;
  } & BusinessContactSettings &
  Pick<WholesaleBusinessSettings, "wholesale_purchases_enabled" | "wholesale_allow_repeat_without_minimum"> &
  OrderBusinessSettings &
  Pick<InventoryBusinessSettings, "out_of_stock_catalog_mode" | "stock_reservations_enabled">;

export type BusinessSettings = CommerceSettings &
  BusinessNotificationSettings &
  CrmBusinessSettings &
  WholesaleBusinessSettings &
  OrderBusinessSettings &
  InventoryBusinessSettings &
  SocialSettings &
  BusinessContactSettings & {
    dashboard_cards: DashboardCardSettings;
  };

export type HolidayBanner = {
  id: string;
  holiday_key: string | null;
  title: string;
  message: string;
  image_url: string | null;
  start_date: string;
  end_date: string;
  is_active: boolean;
  priority: number;
  button_text: string | null;
  button_url: string | null;
  created_at: string;
  updated_at: string;
};

export type HolidayBannerInput = {
  id?: string;
  title: string;
  message: string;
  image_url: string;
  start_date: string;
  end_date: string;
  is_active: boolean;
  priority: number;
  button_text: string;
  button_url: string;
};
