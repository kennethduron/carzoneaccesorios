import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AccountingPeriodsManager } from "@/components/admin/accounting-periods-manager";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAccountingPeriodsPageData } from "@/services/supabase/accounting-periods.service";

export const dynamic = "force-dynamic";

export default async function AccountingPeriodsPage() {
  const profile = await requirePermission("accounting:read");
  const data = await getAccountingPeriodsPageData();
  const canManage =
    hasEffectivePermission(profile.role, profile.permissions, "accounting:create", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "accounting:manage", profile.email);

  return (
    <main className="min-h-screen bg-[#f7f7f8] px-4 py-5 text-[#080808] sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1400px] space-y-5">
        <header className="flex flex-col gap-4 rounded-lg border border-black/10 bg-white p-5 shadow-sm sm:p-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="mb-3">
              <Link href="/admin" className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold text-black/70 transition-colors hover:border-[#e4252c]/35 hover:bg-[#fff1f2] hover:text-[#b91c25]">
                <ArrowLeft size={16} />
                Panel administrativo
              </Link>
            </div>
            <p className="text-sm font-semibold uppercase text-[#b91c25]">Finanzas</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal sm:text-4xl">Períodos contables</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-black/55">Fundación Phase 2I-1 para crear, consultar y administrar períodos abiertos sin cierre mensual, cierre anual ni reaperturas.</p>
          </div>
          <div className="rounded-lg border border-black/10 bg-[#fafafa] px-4 py-3 text-sm text-black/60">
            <span className="font-semibold text-black">Período actual:</span> {data.currentPeriod?.name ?? "Sin períodos configurados"}
          </div>
        </header>

        <AccountingPeriodsManager periods={data.periods} currentPeriod={data.currentPeriod} canManage={canManage} />
      </div>
    </main>
  );
}
