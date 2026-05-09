import { AdminShell } from "@/components/admin/admin-shell";
import { LogoutButton } from "@/components/auth";
import { requirePermission } from "@/lib/auth/session";
import Link from "next/link";

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
    href: null,
    description: "Modulo preparado para seguimiento de pedidos y estados.",
  },
  {
    title: "Facturas",
    href: null,
    description: "Modulo preparado para facturacion y documentos fiscales.",
  },
  {
    title: "Clientes",
    href: "/admin/crm",
    description: "Modulo preparado para CRM, notas y seguimiento comercial.",
  },
  {
    title: "Codigos mayoristas",
    href: "/admin/codigos-mayoristas",
    description: "Crear, activar y auditar codigos que habilitan wholesale_price.",
  },
  {
    title: "Reportes",
    href: "/admin/reportes",
    description: "Modulo preparado para reportes, Excel, CSV y PDFs.",
  },
  {
    title: "Seguridad",
    href: "/admin/seguridad",
    description: "Roles, permisos, logs, backups y control de errores.",
  },
];

export default async function AdminPage() {
  const profile = await requirePermission("admin:access");

  return (
    <AdminShell title="Panel administrativo">
      <div className="mb-6 flex flex-col justify-between gap-3 rounded-lg border border-black/10 bg-white p-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm text-black/50">Sesion activa</p>
          <p className="font-semibold">{profile.full_name || profile.email}</p>
          <p className="text-sm capitalize text-black/55">Rol: {profile.role}</p>
        </div>
        <LogoutButton />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {adminModules.map((module) => {
          const content = (
            <>
              <h2 className="font-semibold">{module.title}</h2>
              <p className="mt-2 text-sm text-black/55">{module.description}</p>
            </>
          );

          return module.href ? (
            <Link
              key={module.title}
              href={module.href}
              className="rounded-lg border border-black/10 bg-white p-5 transition-colors hover:border-[#246a73]"
            >
              {content}
            </Link>
          ) : (
            <article key={module.title} className="rounded-lg border border-black/10 bg-white p-5">
              {content}
            </article>
          );
        })}
      </div>
    </AdminShell>
  );
}
