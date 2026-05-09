import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { ReportsDashboard } from "@/components/admin/reports-dashboard";
import { requirePermission } from "@/lib/auth/session";
import { getAdminReports } from "@/services/supabase/admin-reports.service";

export const dynamic = "force-dynamic";

export default async function AdminReportsPage() {
  await requirePermission("reports:read");
  const reports = await getAdminReports();

  return (
    <AdminShell title="Reportes">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <ReportsDashboard data={reports} />
    </AdminShell>
  );
}
