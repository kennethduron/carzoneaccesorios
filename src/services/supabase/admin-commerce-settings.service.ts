import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { BusinessContactSettings, CommerceSettings, SocialSettings } from "@/types/settings";
import { defaultCommerceSettings, normalizeCommerceSettings } from "@/utils/commerce-settings";

export type AdminCompanySettings = CommerceSettings & SocialSettings & BusinessContactSettings;

export const defaultAdminCompanySettings: AdminCompanySettings = {
  ...defaultCommerceSettings,
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
  customer_service_phone: "",
  customer_service_email: "",
  customer_service_whatsapp: "",
  customer_service_hours: "Lunes a sábado, 8:00 a.m. a 6:00 p.m.",
};

function cleanUrl(value: string) {
  return value.trim();
}

function normalizeSettings(row: Partial<AdminCompanySettings> | null | undefined): AdminCompanySettings {
  return {
    ...normalizeCommerceSettings(row),
    facebook_url: String(row?.facebook_url ?? "").trim(),
    instagram_url: String(row?.instagram_url ?? "").trim(),
    whatsapp_url: String(row?.whatsapp_url ?? "").trim(),
    tiktok_url: String(row?.tiktok_url ?? "").trim(),
    youtube_url: String(row?.youtube_url ?? "").trim(),
    website_url: String(row?.website_url ?? "").trim(),
    trade_name: String(row?.trade_name ?? defaultAdminCompanySettings.trade_name).trim(),
    legal_business_name: String(row?.legal_business_name ?? "").trim(),
    business_rtn: String(row?.business_rtn ?? "").trim(),
    business_address: String(row?.business_address ?? defaultAdminCompanySettings.business_address).trim(),
    customer_service_phone: String(row?.customer_service_phone ?? defaultAdminCompanySettings.customer_service_phone).trim(),
    customer_service_email: String(row?.customer_service_email ?? defaultAdminCompanySettings.customer_service_email).trim(),
    customer_service_whatsapp: String(row?.customer_service_whatsapp ?? "").trim(),
    customer_service_hours: String(row?.customer_service_hours ?? defaultAdminCompanySettings.customer_service_hours).trim(),
  };
}

export async function getAdminCompanySettings(): Promise<AdminCompanySettings> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("company_settings")
    .select(
      "free_shipping_threshold, standard_shipping_fee, cash_on_delivery_percentage, enable_cash_on_delivery_fee, first_wholesale_minimum, facebook_url, instagram_url, whatsapp_url, tiktok_url, youtube_url, website_url, trade_name, legal_business_name, business_rtn, business_address, customer_service_phone, customer_service_email, customer_service_whatsapp, customer_service_hours",
    )
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<AdminCompanySettings>();

  if (error) {
    return defaultAdminCompanySettings;
  }

  return normalizeSettings(data);
}

export async function saveAdminCompanySettings(input: AdminCompanySettings) {
  const supabase = await getSupabaseServerClient();
  const sanitized: AdminCompanySettings = {
    ...normalizeCommerceSettings(input),
    facebook_url: cleanUrl(input.facebook_url),
    instagram_url: cleanUrl(input.instagram_url),
    whatsapp_url: cleanUrl(input.whatsapp_url),
    tiktok_url: cleanUrl(input.tiktok_url),
    youtube_url: cleanUrl(input.youtube_url),
    website_url: cleanUrl(input.website_url),
    trade_name: input.trade_name.trim(),
    legal_business_name: input.legal_business_name.trim(),
    business_rtn: input.business_rtn.trim(),
    business_address: input.business_address.trim(),
    customer_service_phone: input.customer_service_phone.trim(),
    customer_service_email: input.customer_service_email.trim(),
    customer_service_whatsapp: input.customer_service_whatsapp.trim(),
    customer_service_hours: input.customer_service_hours.trim(),
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
