import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { FiscalSettings } from "@/types/fiscal";

export const defaultFiscalSettings: FiscalSettings = {
  legal_name: "Car Zone Accesorios",
  rtn: "",
  cai: "",
  invoice_range_start: "",
  invoice_range_end: "",
  current_invoice_number: "",
  emission_deadline: null,
  fiscal_address: "",
  phone: "",
  email: "",
  logo_url: null,
};

export async function getFiscalSettings(): Promise<FiscalSettings> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("fiscal_settings")
    .select(
      "legal_name, rtn, cai, invoice_range_start, invoice_range_end, current_invoice_number, emission_deadline, fiscal_address, phone, email, logo_url, updated_at",
    )
    .eq("id", true)
    .maybeSingle<FiscalSettings>();

  if (error) {
    if (error.code === "42P01" || error.message.toLowerCase().includes("fiscal_settings")) {
      return defaultFiscalSettings;
    }
    throw new Error(error.message);
  }

  return data ?? defaultFiscalSettings;
}

export async function saveFiscalSettings(input: FiscalSettings) {
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from("fiscal_settings").upsert({
    id: true,
    legal_name: input.legal_name.trim(),
    rtn: input.rtn.trim(),
    cai: input.cai.trim(),
    invoice_range_start: input.invoice_range_start.trim(),
    invoice_range_end: input.invoice_range_end.trim(),
    current_invoice_number: input.current_invoice_number.trim(),
    emission_deadline: input.emission_deadline || null,
    fiscal_address: input.fiscal_address.trim(),
    phone: input.phone.trim(),
    email: input.email.trim(),
    logo_url: input.logo_url?.trim() || null,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(error.message);
  }
}
