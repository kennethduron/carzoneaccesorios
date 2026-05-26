import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { SecurityCenter } from "@/components/admin/security-center";
import { requirePermission } from "@/lib/auth/session";
import { getAdminSecurity } from "@/services/supabase/admin-security.service";

export const dynamic = "force-dynamic";

export default async function AdminSecurityPage() {
  const profile = await requirePermission("audit:read");
  const security = await getAdminSecurity(profile);

  return (
    <AdminShell title="Seguridad">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <SecurityCenter data={security} currentUser={profile} />
    </AdminShell>
  );
}
