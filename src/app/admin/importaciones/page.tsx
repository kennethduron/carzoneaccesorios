import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { ImportFoundationManager } from "@/components/admin/import-foundation-manager";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getImportFoundationData } from "@/services/supabase/import-foundation.service";

export const dynamic = "force-dynamic";

export default async function AdminImportsPage() {
  const profile = await requirePermission("admin:access");
  const canReviewImports =
    hasEffectivePermission(profile.role, profile.permissions, "credit:manage", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "receivables:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "payables:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "payables:manage", profile.email);

  if (!canReviewImports) {
    await requirePermission("technical:tools");
  }

  const data = await getImportFoundationData();

  return (
    <AdminShell title="Importaciones">
      <div className="mb-4">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold text-black/70 transition-colors hover:border-[#e4252c]/35 hover:bg-[#fff1f2] hover:text-[#b91c25]"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <ImportFoundationManager data={data} />
    </AdminShell>
  );
}
