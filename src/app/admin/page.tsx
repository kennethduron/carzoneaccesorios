import Link from "next/link";
import { AdminShell } from "@/components/admin/admin-shell";
import { FiscalAlertsPanel } from "@/components/admin/fiscal-alerts-panel";
import { LogoutButton } from "@/components/auth";
import { requirePermission } from "@/lib/auth/session";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { getAdminInvoices } from "@/services/supabase/admin-invoices.service";
import type { Permission } from "@/types/auth";
import { getFiscalAlerts } from "@/utils/fiscal";

export const dynamic = "force-dynamic";

const adminModules = [
  {
    title: "Productos",
    href: "/admin/productos",
    description: "Crear, editar, desactivar, eliminar, importar y exportar productos.",
    permissions: ["products:manage"] satisfies Permission[],
  },
  {
    title: "Inventario",
    href: "/admin/inventario",
    description: "Entradas, salidas, ajustes, historial y alertas de bajo stock.",
    permissions: ["inventory:manage"] satisfies Permission[],
  },
  {
    title: "Pedidos",
    href: "/admin/pedidos",
    description: "Seguimiento de pedidos, pagos y facturación.",
    permissions: ["orders:read", "orders:manage"] satisfies Permission[],
  },
  {
    title: "Facturas",
    href: "/admin/facturas",
    description: "Facturas fiscales, referencias bancarias, PDF y anulación.",
    permissions: ["invoices:read", "invoices:manage"] satisfies Permission[],
  },
  {
    title: "Clientes",
    href: "/admin/clientes",
    description: "CRM, notas y seguimiento comercial.",
    permissions: ["crm:manage", "customers:manage"] satisfies Permission[],
  },
  {
    title: "Códigos mayoristas",
    href: "/admin/codigos-mayoristas",
    description: "Crear, activar y auditar códigos que habilitan precio mayorista.",
    permissions: ["customers:manage"] satisfies Permission[],
  },
  {
    title: "Reportes",
    href: "/admin/reportes",
    description: "Reportes contables, filtros, Excel, CSV y PDF.",
    permissions: ["reports:read"] satisfies Permission[],
  },
  {
    title: "Seguridad",
    href: "/admin/seguridad",
    description: "Roles, permisos, logs, backups y control de errores.",
    permissions: ["settings:manage", "audit:read"] satisfies Permission[],
  },
  {
    title: "Configuración fiscal",
    href: "/admin/configuracion-fiscal",
    description: "RTN, CAI, rango fiscal, fecha límite y datos legales.",
    permissions: ["fiscal:read", "settings:manage"] satisfies Permission[],
  },
];

function canAccessModule(role: string, permissions: Permission[], modulePermissions: Permission[]) {
  return role === "admin" || modulePermissions.some((permission) => permissions.includes(permission));
}

export default async function AdminPage() {
  const profile = await requirePermission("admin:access");
  const canViewFiscalAlerts =
    profile.role === "admin" ||
    profile.permissions.includes("fiscal:read") ||
    profile.permissions.includes("invoices:read") ||
    profile.permissions.includes("reports:read");
  const canReadInvoices = profile.role === "admin" || profile.permissions.includes("invoices:read");
  const [fiscalSettings, invoices] = canViewFiscalAlerts
    ? await Promise.all([getFiscalSettings(), canReadInvoices ? getAdminInvoices() : Promise.resolve([])])
    : [null, []];
  const fiscalAlerts = fiscalSettings ? getFiscalAlerts(fiscalSettings, invoices) : [];

  return (
    <AdminShell title="Panel administrativo">
      <div className="mb-6 flex flex-col justify-between gap-3 rounded-lg border border-black/10 bg-white p-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm text-black/50">Sesión activa</p>
          <p className="font-semibold">{profile.full_name || profile.email}</p>
          <p className="text-sm capitalize text-black/55">Rol: {profile.role}</p>
        </div>
        <LogoutButton />
      </div>
      {fiscalAlerts.length > 0 ? (
        <div className="mb-6">
          <FiscalAlertsPanel alerts={fiscalAlerts} />
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {adminModules
          .filter((module) => canAccessModule(profile.role, profile.permissions, module.permissions))
          .map((module) => (
            <Link
              key={module.title}
              href={module.href}
              className="rounded-lg border border-black/10 bg-white p-5 transition-colors hover:border-[#246a73]"
            >
              <h2 className="font-semibold">{module.title}</h2>
              <p className="mt-2 text-sm text-black/55">{module.description}</p>
            </Link>
          ))}
      </div>
    </AdminShell>
  );
}
