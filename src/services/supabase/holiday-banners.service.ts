import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { HolidayBanner } from "@/types/settings";

function normalizeBanner(row: HolidayBanner): HolidayBanner {
  return {
    ...row,
    image_url: row.image_url ?? null,
    button_text: row.button_text ?? null,
    button_url: row.button_url ?? null,
    priority: Number(row.priority ?? 0),
  };
}

export async function getActiveHolidayBanner(): Promise<HolidayBanner | null> {
  const supabase = await getSupabaseServerClient();
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("holiday_banners")
    .select("*")
    .eq("is_active", true)
    .lte("start_date", today)
    .gte("end_date", today)
    .order("priority", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<HolidayBanner>();

  if (error) {
    return null;
  }

  return data ? normalizeBanner(data) : null;
}

export async function getAdminHolidayBanners(): Promise<HolidayBanner[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("holiday_banners")
    .select("*")
    .order("start_date", { ascending: false })
    .order("priority", { ascending: false })
    .returns<HolidayBanner[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(normalizeBanner);
}
