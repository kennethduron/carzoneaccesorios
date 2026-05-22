import { getSupabasePublicClient } from "@/lib/supabase";
import type { PublicCompanySettings } from "@/types/settings";
import {
  defaultCommerceSettings,
  defaultInventoryBusinessSettings,
  defaultOrderBusinessSettings,
  defaultWholesaleBusinessSettings,
  normalizeCommerceSettings,
} from "@/utils/commerce-settings";

const defaultPublicCompanySettings: PublicCompanySettings = {
  company_name: "Car Zone Accesorios",
  currency: "HNL",
  tax_rate: 0.15,
  logo_url: null,
  ...defaultCommerceSettings,
  wholesale_purchases_enabled: defaultWholesaleBusinessSettings.wholesale_purchases_enabled,
  wholesale_allow_repeat_without_minimum: defaultWholesaleBusinessSettings.wholesale_allow_repeat_without_minimum,
  ...defaultOrderBusinessSettings,
  out_of_stock_catalog_mode: defaultInventoryBusinessSettings.out_of_stock_catalog_mode,
  stock_reservations_enabled: defaultInventoryBusinessSettings.stock_reservations_enabled,
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

function normalizeUrl(value: unknown) {
  return String(value ?? "").trim();
}

function normalizePublicSettings(row: Partial<PublicCompanySettings> | null | undefined): PublicCompanySettings {
  return {
    company_name: String(row?.company_name ?? defaultPublicCompanySettings.company_name),
    currency: String(row?.currency ?? defaultPublicCompanySettings.currency),
    tax_rate: Number(row?.tax_rate ?? defaultPublicCompanySettings.tax_rate),
    logo_url: row?.logo_url ?? null,
    ...normalizeCommerceSettings(row),
    wholesale_purchases_enabled:
      row?.wholesale_purchases_enabled ?? defaultPublicCompanySettings.wholesale_purchases_enabled,
    wholesale_allow_repeat_without_minimum:
      row?.wholesale_allow_repeat_without_minimum ?? defaultPublicCompanySettings.wholesale_allow_repeat_without_minimum,
    allow_bank_transfer: row?.allow_bank_transfer ?? defaultPublicCompanySettings.allow_bank_transfer,
    allow_cash_on_delivery: row?.allow_cash_on_delivery ?? defaultPublicCompanySettings.allow_cash_on_delivery,
    bac_card_status: row?.bac_card_status ?? defaultPublicCompanySettings.bac_card_status,
    send_order_confirmation_email:
      row?.send_order_confirmation_email ?? defaultPublicCompanySettings.send_order_confirmation_email,
    send_order_status_update_email:
      row?.send_order_status_update_email ?? defaultPublicCompanySettings.send_order_status_update_email,
    require_bank_reference: row?.require_bank_reference ?? defaultPublicCompanySettings.require_bank_reference,
    transfer_receipt_requirement:
      row?.transfer_receipt_requirement ?? defaultPublicCompanySettings.transfer_receipt_requirement,
    out_of_stock_catalog_mode: row?.out_of_stock_catalog_mode ?? defaultPublicCompanySettings.out_of_stock_catalog_mode,
    stock_reservations_enabled: row?.stock_reservations_enabled ?? defaultPublicCompanySettings.stock_reservations_enabled,
    facebook_url: normalizeUrl(row?.facebook_url),
    instagram_url: normalizeUrl(row?.instagram_url),
    whatsapp_url: normalizeUrl(row?.whatsapp_url),
    tiktok_url: normalizeUrl(row?.tiktok_url),
    youtube_url: normalizeUrl(row?.youtube_url),
    website_url: normalizeUrl(row?.website_url),
    trade_name: String(row?.trade_name ?? defaultPublicCompanySettings.trade_name),
    legal_business_name: String(row?.legal_business_name ?? ""),
    business_rtn: String(row?.business_rtn ?? ""),
    business_address: String(row?.business_address ?? defaultPublicCompanySettings.business_address),
    customer_service_phone: String(row?.customer_service_phone ?? defaultPublicCompanySettings.customer_service_phone),
    customer_service_email: String(row?.customer_service_email ?? defaultPublicCompanySettings.customer_service_email),
    customer_service_whatsapp: String(row?.customer_service_whatsapp ?? ""),
    customer_service_hours: String(row?.customer_service_hours ?? defaultPublicCompanySettings.customer_service_hours),
  };
}

export async function getPublicCompanySettingsClient(): Promise<PublicCompanySettings> {
  const supabase = getSupabasePublicClient();
  const { data, error } = await supabase.from("public_company_settings").select("*").maybeSingle<PublicCompanySettings>();

  if (error) {
    return defaultPublicCompanySettings;
  }

  return normalizePublicSettings(data);
}
