import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AccountingManager } from "@/components/admin/accounting-manager";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAccountingPageData } from "@/services/supabase/accounting.service";

export const dynamic = "force-dynamic";

export default async function AdminAccountingPage({
  searchParams,
}: {
  searchParams: Promise<{ account_page?: string; journal_page?: string }>;
}) {
  const profile = await requirePermission("accounting:read");
  const params = await searchParams;
  const data = await getAccountingPageData({
    accountPage: Number(params.account_page ?? 1),
    accountPageSize: 50,
    journalPage: Number(params.journal_page ?? 1),
    journalPageSize: 25,
  });

  const canManage = hasEffectivePermission(profile.role, profile.permissions, "accounting:manage", profile.email);
  const canCreate = hasEffectivePermission(profile.role, profile.permissions, "accounting:create", profile.email);
  const canPost = hasEffectivePermission(profile.role, profile.permissions, "accounting:post", profile.email);
  const canReverse = hasEffectivePermission(profile.role, profile.permissions, "accounting:reverse", profile.email);

  return (
    <main className="min-h-screen bg-[#f7f7f8] px-4 py-5 text-[#080808] sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1400px]">
        <header className="mb-6 flex flex-col gap-4 rounded-2xl border border-black/10 bg-white p-5 shadow-sm sm:p-6 lg:flex-row lg:items-center lg:justify-between">
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
            <h1 className="mt-1 text-3xl font-semibold tracking-normal sm:text-4xl">Contabilidad</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-black/55">
              Catálogo de cuentas, libro diario y partidas manuales de la fase 1.
            </p>
          </div>
          <div className="rounded-xl border border-black/10 bg-[#fafafa] px-4 py-3 text-sm text-black/60">
            <span className="font-semibold text-black">Modo actual:</span> Operación contable
          </div>
        </header>

        <AccountingManager
          data={data}
          canManage={canManage}
          canCreate={canCreate}
          canPost={canPost}
          canReverse={canReverse}
        />
      </div>
    </main>
  );
}
