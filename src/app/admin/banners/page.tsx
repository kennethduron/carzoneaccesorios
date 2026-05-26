import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { HolidayBannersManager } from "@/components/admin/holiday-banners-manager";
import { requirePermission } from "@/lib/auth/session";
import {
  getAdminHolidayBanners,
  getHolidayBannerAuditEntries,
  getHolidayBannerStorageSummary,
} from "@/services/supabase/holiday-banners.service";

export const dynamic = "force-dynamic";

export default async function AdminBannersPage() {
  await requirePermission("commercial_settings:manage");
  const [banners, auditEntries, storageSummary] = await Promise.all([
    getAdminHolidayBanners(),
    getHolidayBannerAuditEntries(),
    getHolidayBannerStorageSummary(),
  ]);

  return (
    <AdminShell title="Promociones y dias festivos">
      <div className="mb-5">
        <Link href="/admin" className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm">
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <HolidayBannersManager banners={banners} auditEntries={auditEntries} storageSummary={storageSummary} />
    </AdminShell>
  );
}
