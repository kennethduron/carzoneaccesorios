import { redirect } from "next/navigation";
import { AccountsReceivableImportManager } from "@/components/admin/accounts-receivable-import-manager";
import { AccountsReceivableManager } from "@/components/admin/accounts-receivable-manager";
import { AccountsReceivableSummary } from "@/components/admin/accounts-receivable-summary";
import { AccountsReceivableTabs, type ReceivableSection } from "@/components/admin/accounts-receivable-tabs";
import { AdminShell } from "@/components/admin/admin-shell";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getHistoricalAccountsReceivableImportData, getHistoricalReceivableAttentionCount } from "@/services/supabase/accounts-receivable-import.service";
import { getAdminAccountsReceivable } from "@/services/supabase/credit.service";
import type { HistoricalReceivableRowFilter } from "@/types/accounts-receivable-import";
import type { AdminReceivableFilter, AdminReceivableSort, AdminReceivableSortDirection } from "@/types/credit";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const number = (value: string | undefined, fallback: number) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback; };

export default async function AccountsReceivablePage({ searchParams }: { searchParams?: Promise<Params> }) {
  const profile = await requirePermission("admin:access");
  const canRead = hasEffectivePermission(profile.role, profile.permissions, "receivables:read", profile.email)
    || hasEffectivePermission(profile.role, profile.permissions, "credit:manage", profile.email);
  if (!canRead) redirect("/sin-permiso");
  const params = (await searchParams) ?? {};
  const requestedSection = one(params.section);
  const section: ReceivableSection = requestedSection === "summary" || requestedSection === "import" ? requestedSection : "accounts";
  const canExport = hasEffectivePermission(profile.role, profile.permissions, "receivables:export", profile.email);
  const canImport = hasEffectivePermission(profile.role, profile.permissions, "receivables:import", profile.email);
  const canApply = hasEffectivePermission(profile.role, profile.permissions, "receivables:apply", profile.email);
  const canAssign = hasEffectivePermission(profile.role, profile.permissions, "receivables:assign", profile.email);
  const canRollback = ["technical_owner", "business_owner"].includes(profile.role)
    && hasEffectivePermission(profile.role, profile.permissions, "receivables:rollback", profile.email);
  const canMarkPaid = hasEffectivePermission(profile.role, profile.permissions, "credit:mark_paid", profile.email);
  const attentionCount = await getHistoricalReceivableAttentionCount();

  const accountsData = section !== "import" ? await getAdminAccountsReceivable({
    filter: (one(params.status) ?? "pending") as AdminReceivableFilter,
    query: one(params.q) ?? "",
    sort: (one(params.sort) ?? "created") as AdminReceivableSort,
    direction: (one(params.direction) ?? "desc") as AdminReceivableSortDirection,
    page: number(one(params.page), 1),
    pageSize: number(one(params.pageSize), 20),
  }) : null;
  const importData = section === "import" ? await getHistoricalAccountsReceivableImportData({
    batchId: one(params.importBatch) ?? null,
    rowId: one(params.importRow) ?? null,
    rowPage: number(one(params.importPage), 1),
    rowPageSize: 20,
    rowQuery: one(params.importQuery) ?? "",
    rowFilter: (one(params.importStatus) ?? "all") as HistoricalReceivableRowFilter,
    canImport, canApply, canAssign, canRollback,
  }) : null;

  return <AdminShell title="Cuentas por cobrar" description="Seguimiento de cartera, vencimientos, abonos y facturación" variant="wide" backHref="/admin" backLabel="Volver al inicio">
    <AccountsReceivableTabs section={section} attentionCount={attentionCount}/>
    {section === "summary" && accountsData ? <AccountsReceivableSummary summary={accountsData.summary}/> : null}
    {section === "accounts" && accountsData ? <AccountsReceivableManager data={accountsData} canMarkPaid={canMarkPaid} canExport={canExport}/> : null}
    {section === "import" && importData ? <AccountsReceivableImportManager data={importData}/> : null}
  </AdminShell>;
}
