import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AccountingPeriod, AccountingPeriodsPageData } from "@/types/accounting";

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function getAccountingPeriodsPageData(): Promise<AccountingPeriodsPageData> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounting_periods")
    .select("id, name, period_type, start_date, end_date, status, fiscal_year, closed_at, closed_by, reopened_at, reopened_by, notes, created_by, created_at, updated_at")
    .order("start_date", { ascending: false })
    .limit(120)
    .returns<AccountingPeriod[]>();

  if (error) {
    throw new Error(error.message);
  }

  const periods = data ?? [];
  const today = todayKey();
  const currentPeriod = periods.find((period) => period.status === "open" && period.start_date <= today && period.end_date >= today) ?? null;

  return {
    periods,
    currentPeriod,
    openPeriods: periods.filter((period) => period.status === "open").length,
    closedPeriods: periods.filter((period) => period.status === "closed").length,
  };
}
