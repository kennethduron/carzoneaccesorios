import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { PublicCompanySettings, SocialSettings } from "@/types/settings";
import { defaultCommerceSettings, normalizeCommerceSettings } from "@/utils/commerce-settings";

const defaultSocialSettings: SocialSettings = {
  facebook_url: "",
  instagram_url: "",
  whatsapp_url: "",
  tiktok_url: "",
  youtube_url: "",
  website_url: "",
};

export const defaultPublicCompanySettings: PublicCompanySettings = {
  company_name: "Car Zone Accesorios",
  currency: "HNL",
  tax_rate: 0.15,
  logo_url: null,
  ...defaultCommerceSettings,
  ...defaultSocialSettings,
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
    facebook_url: normalizeUrl(row?.facebook_url),
    instagram_url: normalizeUrl(row?.instagram_url),
    whatsapp_url: normalizeUrl(row?.whatsapp_url),
    tiktok_url: normalizeUrl(row?.tiktok_url),
    youtube_url: normalizeUrl(row?.youtube_url),
    website_url: normalizeUrl(row?.website_url),
  };
}

export async function getPublicCompanySettings(): Promise<PublicCompanySettings> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.from("public_company_settings").select("*").maybeSingle<PublicCompanySettings>();

  if (error) {
    return defaultPublicCompanySettings;
  }

  return normalizePublicSettings(data);
}
