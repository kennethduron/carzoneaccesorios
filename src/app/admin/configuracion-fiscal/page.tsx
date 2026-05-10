import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { FiscalSettingsForm } from "@/components/admin/fiscal-settings-form";
import { requirePermission } from "@/lib/auth/session";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { getFiscalAlerts } from "@/utils/fiscal";

export const dynamic = "force-dynamic";

export default async function AdminFiscalSettingsPage() {
  await requirePermission("settings:manage");
  const settings = await getFiscalSettings();
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
      <FiscalSettingsForm settings={settings} alerts={alerts} />
    </AdminShell>
  );
}
