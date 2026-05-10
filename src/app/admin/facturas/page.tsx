import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { AdminInvoicesManager } from "@/components/admin/admin-invoices-manager";
import { requirePermission } from "@/lib/auth/session";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { getAdminInvoices } from "@/services/supabase/admin-invoices.service";
import { getFiscalAlerts } from "@/utils/fiscal";

export const dynamic = "force-dynamic";

export default async function AdminInvoicesPage() {
  const profile = await requirePermission("invoices:read");
  const canCancelInvoices = profile.role === "admin" || profile.permissions.includes("invoices:manage");
  const [invoices, fiscalSettings] = await Promise.all([getAdminInvoices(), getFiscalSettings()]);
  const fiscalAlerts = getFiscalAlerts(fiscalSettings, invoices);

  return (
    <AdminShell title="Facturas">
      <div className="mb-5 flex flex-wrap gap-2">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
        <Link
          href="/admin/configuracion-fiscal"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <Settings size={16} />
          Configuración fiscal
        </Link>
      </div>
      <AdminInvoicesManager
        invoices={invoices}
        fiscalSettings={fiscalSettings}
        fiscalAlerts={fiscalAlerts}
        canCancelInvoices={canCancelInvoices}
      />
    </AdminShell>
  );
}
