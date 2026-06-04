import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { FiscalSettingsForm } from "@/components/admin/fiscal-settings-form";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { getFiscalAlerts } from "@/utils/fiscal";

export const dynamic = "force-dynamic";

export default async function AdminFiscalSettingsPage() {
  const profile = await requirePermission("fiscal:read");
  const canEditTechnicalSettings = hasEffectivePermission(profile.role, profile.permissions, "settings:fiscal", profile.email);
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
      <div className="space-y-5">
        <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">
          Esta pantalla queda reservada para datos fiscales: RTN, CAI, rango, correlativo y datos legales de factura.
          Redes, contacto, mayoristas, pagos por link y notificaciones se gestionan en{" "}
          <Link href="/admin/configuracion" className="font-semibold text-[#e4252c]">
            Configuración empresarial
          </Link>
          .
        </div>
        <FiscalSettingsForm settings={settings} alerts={alerts} canEdit={canEditTechnicalSettings} />
      </div>
    </AdminShell>
  );
}

