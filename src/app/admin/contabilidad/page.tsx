import { AdminBackButton } from "@/components/admin/admin-back-button";
import { AccountingManager } from "@/components/admin/accounting-manager";
import { AdminShell } from "@/components/admin/admin-shell";
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
    <AdminShell title="Contabilidad">
      <AdminBackButton />
      <AccountingManager
        data={data}
        canManage={canManage}
        canCreate={canCreate}
        canPost={canPost}
        canReverse={canReverse}
      />
    </AdminShell>
  );
}
