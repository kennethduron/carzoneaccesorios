import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FinancialCenterManager } from "@/components/admin/financial-center-manager";
import { normalizeFinancialCenterTab } from "@/lib/accounting-navigation";
import { hasEffectivePermission, isTechnicalOwner } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { writeErrorLog } from "@/lib/error-logging";
import { getAccountingPageData, getJournalEntryByIdForViewer } from "@/services/supabase/accounting.service";
import { getFinancialCenterData } from "@/services/supabase/financial-center.service";
import type { JournalEntryViewerData, JournalEntryViewerStatus } from "@/types/accounting";
import { uuidLike } from "@/utils/validation";

export const dynamic = "force-dynamic";

type AccountingSearchParams = {
  account_page?: string | string[];
  journal_page?: string | string[];
  partida?: string | string[];
  tab?: string | string[];
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function getFocusedJournalEntry(journalEntryId: string): Promise<{
  data: JournalEntryViewerData | null;
  status: JournalEntryViewerStatus;
}> {
  try {
    const data = await getJournalEntryByIdForViewer(journalEntryId);
    return { data, status: data ? "loaded" : "not_found" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo consultar la partida contable.";
    await writeErrorLog({
      route: "/admin/contabilidad",
      module: "accounting",
      action: "accounting.journal_entry_viewer_query_failed",
      errorMessage: message,
      customerMessage: "No fue posible cargar la partida contable. Intente nuevamente.",
      metadata: { journal_entry_id: journalEntryId },
    });
    return { data: null, status: "load_error" };
  }
}

export default async function AdminAccountingPage({
  searchParams,
}: {
  searchParams: Promise<AccountingSearchParams>;
}) {
  const profile = await requirePermission("accounting:read");
  const params = await searchParams;
  const requestedEntryId = firstParam(params.partida)?.trim() || null;
  const requestedTab = normalizeFinancialCenterTab(firstParam(params.tab));
  const initialTab = requestedEntryId ? "journal" : requestedTab;
  const validatedEntryId = requestedEntryId ? uuidLike(requestedEntryId, "ID de partida contable") : null;
  const focusedEntryPromise = validatedEntryId
    ? validatedEntryId.ok
      ? getFocusedJournalEntry(validatedEntryId.value)
      : Promise.resolve({ data: null, status: "invalid" as const })
    : Promise.resolve({ data: null, status: "idle" as const });

  const [accountingData, financialData, focusedEntry] = await Promise.all([
    getAccountingPageData({
      accountPage: Number(firstParam(params.account_page) ?? 1),
      accountPageSize: 50,
      journalPage: Number(firstParam(params.journal_page) ?? 1),
      journalPageSize: 25,
    }),
    getFinancialCenterData(),
    focusedEntryPromise,
  ]);

  const canManage = hasEffectivePermission(profile.role, profile.permissions, "accounting:manage", profile.email);
  const canCreate = hasEffectivePermission(profile.role, profile.permissions, "accounting:create", profile.email);
  const canEditDrafts = hasEffectivePermission(profile.role, profile.permissions, "accounting:edit_draft_entries", profile.email);
  const canPost = hasEffectivePermission(profile.role, profile.permissions, "accounting:post", profile.email);
  const canReverse = hasEffectivePermission(profile.role, profile.permissions, "accounting:reverse", profile.email);
  const canConfigureAccounting = hasEffectivePermission(profile.role, profile.permissions, "accounting:settings", profile.email);
  const canExportAccounting = hasEffectivePermission(profile.role, profile.permissions, "accounting:export", profile.email);
  const canExportTechnicalCsv = canExportAccounting && isTechnicalOwner(profile.role, profile.email);

  return (
    <main className="min-h-screen bg-[#f7f7f8] px-4 py-5 text-[#080808] sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1400px]">
        <header className="mb-6 flex flex-col gap-4 rounded-lg border border-black/10 bg-white p-5 shadow-sm sm:p-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="mb-3">
              <Link
                href="/admin"
                className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold text-black/70 transition-colors hover:border-[#e4252c]/35 hover:bg-[#fff1f2] hover:text-[#b91c25]"
              >
                <ArrowLeft size={16} />
                Panel administrativo
              </Link>
            </div>
            <p className="text-sm font-semibold uppercase text-[#b91c25]">Panel administrativo</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal sm:text-4xl">Centro financiero</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-black/55">
              Contabilidad, configuración contable, eventos financieros y preparación para automatización futura.
            </p>
          </div>
          <div className="rounded-lg border border-black/10 bg-[#fafafa] px-4 py-3 text-sm text-black/60">
            <span className="font-semibold text-black">Automatización:</span> {financialData.summary.automationMode === "disabled" ? "Desactivada" : "Configurada"}
          </div>
        </header>

        <FinancialCenterManager
          accountingData={accountingData}
          financialData={financialData}
          initialTab={initialTab}
          focusedEntryData={focusedEntry.data}
          focusedEntryId={requestedEntryId}
          focusedEntryStatus={focusedEntry.status}
          canManage={canManage}
          canCreate={canCreate}
          canEditDrafts={canEditDrafts}
          canPost={canPost}
          canReverse={canReverse}
          canConfigureAccounting={canConfigureAccounting}
          canExportAccounting={canExportAccounting}
          canExportTechnicalCsv={canExportTechnicalCsv}
          canScanEvents={canManage}
          canGenerateDrafts={canManage}
        />
      </div>
    </main>
  );
}
