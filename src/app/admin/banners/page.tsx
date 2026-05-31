import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { HolidayBannersManager } from "@/components/admin/holiday-banners-manager";
import { requirePermission } from "@/lib/auth/session";
import {
  getAdminHolidayBanners,
  getHolidayBannerAuditEntries,
  getHolidayBannerStorageSummary,
  getTechnicalAlertSettings,
  sanitizeHolidayBannersForOperationalOwner,
} from "@/services/supabase/holiday-banners.service";

export const dynamic = "force-dynamic";

export default async function AdminBannersPage() {
  const profile = await requirePermission("commercial_settings:manage");
  const canViewTechnical = profile.permissions.includes("technical:tools");
  const [banners, auditEntries, storageSummary, technicalAlertSettings] = await Promise.all([
    getAdminHolidayBanners(),
    getHolidayBannerAuditEntries(canViewTechnical),
    canViewTechnical ? getHolidayBannerStorageSummary() : Promise.resolve(null),
    canViewTechnical ? getTechnicalAlertSettings() : Promise.resolve(null),
  ]);
  const visibleBanners = canViewTechnical ? banners : sanitizeHolidayBannersForOperationalOwner(banners);

  return (
    <AdminShell title="Promociones y dias festivos">
      <div className="mb-5">
        <Link href="/admin" className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm">
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <HolidayBannersManager
        banners={visibleBanners}
        auditEntries={auditEntries}
        storageSummary={storageSummary}
        technicalAlertSettings={technicalAlertSettings}
        canViewTechnical={canViewTechnical}
      />
    </AdminShell>
  );
}
