import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { BusinessSettingsCenter } from "@/components/admin/business-settings-center";
import { requirePermission } from "@/lib/auth/session";
import { getAdminBusinessSettings } from "@/services/supabase/admin-business-settings.service";

export const dynamic = "force-dynamic";

export default async function AdminBusinessSettingsPage() {
  const profile = await requirePermission("admin:access");

  if (!["business_owner", "admin", "technical_owner"].includes(profile.role)) {
    redirect("/sin-permiso");
  }

  const settings = await getAdminBusinessSettings();

  return (
    <AdminShell title="Configuración empresarial">
      <BusinessSettingsCenter settings={settings} currentRole={profile.role} />
    </AdminShell>
  );
}
