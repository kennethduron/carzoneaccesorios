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

function displayUserName(user: { full_name: string | null; email: string | null } | undefined) {
  return user?.full_name?.trim() || user?.email?.trim() || null;
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

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((period) => period.closed_by).filter((value): value is string => Boolean(value)))];
  const closedByUsers = new Map<string, { full_name: string | null; email: string | null }>();

  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("id, full_name, email")
      .in("id", userIds)
      .returns<Array<{ id: string; full_name: string | null; email: string | null }>>();

    if (usersError) {
      throw new Error(usersError.message);
    }

    for (const user of users ?? []) {
      closedByUsers.set(user.id, { full_name: user.full_name, email: user.email });
    }
  }

  const periods = rows.map((period) => ({
    ...period,
    closed_by_name: period.closed_by ? displayUserName(closedByUsers.get(period.closed_by)) : null,
  }));
  const today = todayKey();
  const currentPeriod = periods.find((period) => period.status === "open" && period.start_date <= today && period.end_date >= today) ?? null;

  return {
    periods,
    currentPeriod,
    openPeriods: periods.filter((period) => period.status === "open").length,
    closedPeriods: periods.filter((period) => period.status === "closed").length,
  };
}
