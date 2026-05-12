import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { FiscalSettingsForm } from "@/components/admin/fiscal-settings-form";
import { NotificationSettingsForm } from "@/components/admin/notification-settings-form";
import { requirePermission } from "@/lib/auth/session";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { getNotificationSettings } from "@/services/supabase/admin-notification-settings.service";
import { getFiscalAlerts } from "@/utils/fiscal";

export const dynamic = "force-dynamic";

export default async function AdminFiscalSettingsPage() {
  const profile = await requirePermission("fiscal:read");
  const canEdit = profile.role === "admin" || profile.permissions.includes("settings:manage");
  const [settings, notificationSettings] = await Promise.all([getFiscalSettings(), getNotificationSettings()]);
  const alerts = getFiscalAlerts(settings);

  return (
    <AdminShell title="Configuración fiscal">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <div className="space-y-5">
        <FiscalSettingsForm settings={settings} alerts={alerts} canEdit={canEdit} />
        <NotificationSettingsForm settings={notificationSettings} canEdit={canEdit} />
      </div>
    </AdminShell>
  );
}
