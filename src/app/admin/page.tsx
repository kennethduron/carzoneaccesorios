import Link from "next/link";
import { AdminShell } from "@/components/admin/admin-shell";
import { LogoutButton } from "@/components/auth";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const adminModules = [
  {
    title: "Productos",
    href: "/admin/productos",
    description: "Crear, editar, desactivar, eliminar, importar y exportar productos.",
  },
  {
    title: "Inventario",
    href: "/admin/inventario",
    description: "Entradas, salidas, ajustes, historial y alertas de bajo stock.",
  },
  {
    title: "Pedidos",
    href: "/admin/pedidos",
    description: "Seguimiento de pedidos, pagos y facturación.",
  },
  {
    title: "Facturas",
    href: "/admin/facturas",
    description: "Facturas fiscales, referencias bancarias, PDF y anulación.",
  },
  {
    title: "Clientes",
    href: "/admin/clientes",
    description: "CRM, notas y seguimiento comercial.",
  },
  {
    title: "Códigos mayoristas",
    href: "/admin/codigos-mayoristas",
    description: "Crear, activar y auditar códigos que habilitan precio mayorista.",
  },
  {
    title: "Reportes",
    href: "/admin/reportes",
    description: "Reportes contables, filtros, Excel, CSV y PDF.",
  },
  {
    title: "Seguridad",
    href: "/admin/seguridad",
    description: "Roles, permisos, logs, backups y control de errores.",
  },
  {
    title: "Configuración fiscal",
    href: "/admin/configuracion-fiscal",
    description: "RTN, CAI, rango fiscal, fecha límite y datos legales.",
  },
];

export default async function AdminPage() {
  const profile = await requirePermission("admin:access");

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
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {adminModules.map((module) => (
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
