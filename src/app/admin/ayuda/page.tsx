import Link from "next/link";
import { ArrowLeft, BookOpen, ClipboardList, MessageCircle, ShieldCheck } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import type { AppRole, AuthProfile, Permission } from "@/types/auth";

export const dynamic = "force-dynamic";

type HelpBlock = {
  title: string;
  description: string;
  href: string;
  permissions: Permission[];
  roles: AppRole[];
  checklist: string[];
  avoid: string;
};

type DailyTip = {
  title: string;
  text: string;
  permissions?: Permission[];
};

const adminRoles: AppRole[] = ["technical_owner", "business_owner", "admin"];
const salesRoles: AppRole[] = ["technical_owner", "business_owner", "admin", "vendedor", "soporte"];
const warehouseRoles: AppRole[] = ["technical_owner", "business_owner", "admin", "bodega"];
const fiscalRoles: AppRole[] = ["technical_owner", "business_owner", "admin", "contadora"];

const helpBlocks: HelpBlock[] = [
  {
    title: "Atender pedidos nuevos",
    description: "Revisa compras recientes, productos, cliente, pago y siguiente estado.",
    href: "/admin/pedidos",
    permissions: ["orders:read", "orders:manage"],
    roles: ["technical_owner", "business_owner", "admin", "vendedor", "soporte"],
    checklist: ["Abrir pedido.", "Ver productos y cantidades.", "Revisar datos del cliente.", "Confirmar si el pago ya aplica.", "Registrar nota si hay duda."],
    avoid: "No avances pedidos sin revisar pago y reserva.",
  },
  {
    title: "Preparar y despachar",
    description: "Usa el flujo logistico para preparacion, empacado, enviado, en ruta y entregado.",
    href: "/admin/pedidos?task=to_prepare",
    permissions: ["orders:manage_logistics", "reservations:review"],
    roles: warehouseRoles,
    checklist: ["Filtrar pedidos listos.", "Verificar productos fisicos.", "Empacar con cuidado.", "Actualizar estado real.", "Avisar si falta stock."],
    avoid: "No marques entregado si el cliente aun no recibio el pedido.",
  },
  {
    title: "Validar pagos",
    description: "Confirma efectivo, transferencia o tarjeta por link solo con evidencia real.",
    href: "/admin/pedidos?task=pending_payments",
    permissions: ["payments:read", "payments:confirm", "payments:reject"],
    roles: adminRoles,
    checklist: ["Revisar metodo.", "Comparar monto.", "Revisar referencia o comprobante.", "Contactar cliente si hay duda.", "Confirmar o rechazar con motivo."],
    avoid: "No confirmes pago de tarjeta antes de verificar el pago externo.",
  },
  {
    title: "Emitir o consultar facturas",
    description: "Genera factura solo con pago confirmado y datos fiscales correctos.",
    href: "/admin/facturas",
    permissions: ["invoices:read", "invoices:create", "fiscal:read"],
    roles: fiscalRoles,
    checklist: ["Revisar pago aprobado.", "Validar nombre y RTN.", "Ver CAI y rango.", "Generar si corresponde.", "Abrir, descargar o imprimir PDF."],
    avoid: "No emitas si hay dudas en datos fiscales.",
  },
  {
    title: "Dar seguimiento CRM",
    description: "Consulta clientes, agrega notas y crea seguimientos con fecha.",
    href: "/admin/clientes",
    permissions: ["crm:manage", "customers:read"],
    roles: salesRoles,
    checklist: ["Buscar cliente.", "Abrir perfil.", "Leer historial.", "Agregar nota clara.", "Crear proxima accion."],
    avoid: "No dejes acuerdos importantes solo en mensajes externos.",
  },
  {
    title: "Gestionar mayoristas",
    description: "Aprueba, rechaza o suspende acceso mayorista segun criterio comercial.",
    href: "/admin/clientes-mayoristas",
    permissions: ["wholesale:manage"],
    roles: adminRoles,
    checklist: ["Revisar solicitud.", "Validar negocio.", "Confirmar contacto.", "Evaluar volumen.", "Aprobar o rechazar con criterio."],
    avoid: "No apruebes mayoristas sin validar que son cuentas reales.",
  },
  {
    title: "Mantener productos",
    description: "Crea o edita catalogo, precios, categoria, SKU, imagenes y estado.",
    href: "/admin/productos",
    permissions: ["products:manage"],
    roles: adminRoles,
    checklist: ["Completar SKU.", "Asignar categoria.", "Definir precio normal.", "Definir precio mayorista.", "Activar solo si esta listo."],
    avoid: "No publiques productos sin imagen, precio revisado o stock confirmado.",
  },
  {
    title: "Controlar inventario",
    description: "Revisa stock disponible, reservado, bajo minimo y movimientos.",
    href: "/admin/inventario",
    permissions: ["inventory:manage"],
    roles: warehouseRoles,
    checklist: ["Buscar producto.", "Revisar disponible.", "Revisar reservado.", "Registrar entrada real.", "Anotar ajustes."],
    avoid: "No vendas stock reservado como si estuviera libre.",
  },
  {
    title: "Publicar banners",
    description: "Administra promociones visuales con prioridad, fecha, imagen o video.",
    href: "/admin/banners",
    permissions: ["commercial_settings:manage"],
    roles: adminRoles,
    checklist: ["Crear banner.", "Usar imagen o video claro.", "Definir prioridad.", "Revisar fechas.", "Activar o desactivar."],
    avoid: "No uses piezas con texto pequeno que no se lea en celular.",
  },
  {
    title: "Revisar reportes",
    description: "Consulta ventas, clientes, inventario y facturacion con filtros.",
    href: "/admin/reportes",
    permissions: ["reports:read", "reports:fiscal_read"],
    roles: ["technical_owner", "business_owner", "admin", "contadora"],
    checklist: ["Elegir reporte.", "Filtrar por fecha.", "Revisar totales.", "Comparar si aplica.", "Exportar solo lo necesario."],
    avoid: "No mezcles reportes operativos con cierres fiscales sin filtros.",
  },
];

const dailyTips: DailyTip[] = [
  {
    title: "Si no aparece un boton",
    text: "Puede ser por permisos, estado del pedido o una condicion pendiente. Revisa el manual antes de pedir cambio.",
  },
  {
    title: "Si el cliente paga con tarjeta",
    text: "El sitio no procesa tarjetas. Usa WhatsApp, envia el link externo y confirma manualmente cuando el pago este verificado.",
    permissions: ["payments:read", "orders:read"],
  },
  {
    title: "Si necesitas enviar factura",
    text: "Abre la factura, descarga el PDF y adjuntalo manualmente por WhatsApp o correo si el cliente lo solicita.",
    permissions: ["invoices:read"],
  },
  {
    title: "Si falta stock",
    text: "No prometas entrega. Revisa inventario, alternativas y fecha de reposicion antes de responder al cliente.",
    permissions: ["inventory:manage", "products:read"],
  },
  {
    title: "Si hay datos fiscales incorrectos",
    text: "Corrige antes de emitir factura cuando tengas permiso. Si ya fue emitida, sigue el proceso fiscal correspondiente.",
    permissions: ["invoices:correct", "fiscal:read"],
  },
];

function hasAnyPermission(profile: AuthProfile, permissions?: Permission[]) {
  if (!permissions || permissions.length === 0) return true;
  return permissions.some((permission) => profile.permissions.includes(permission));
}

function isBlockVisible(profile: AuthProfile, block: HelpBlock) {
  return block.roles.includes(profile.role) || hasAnyPermission(profile, block.permissions);
}

export default async function AdminHelpPage() {
  const profile = await requirePermission("admin:access");
  const visibleBlocks = helpBlocks.filter((block) => isBlockVisible(profile, block));
  const visibleTips = dailyTips.filter((tip) => hasAnyPermission(profile, tip.permissions));

  return (
    <AdminShell title="Ayuda interna">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link href="/admin" className="inline-flex w-fit items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm">
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
        <Link href="/admin/guia" className="inline-flex w-fit items-center gap-2 rounded-md bg-[#080808] px-3 py-2 text-sm font-semibold text-white">
          <BookOpen size={16} />
          Ver manual completo
        </Link>
      </div>

      <section className="rounded-lg border border-black/10 bg-white p-5">
        <p className="text-sm text-black/50">Centro de ayuda del CRM/Admin</p>
        <h2 className="mt-1 text-2xl font-semibold">Que hacer segun tu tarea</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">
          Usa esta pantalla para resolver dudas rapidas. La guia completa contiene los pasos detallados por modulo.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <QuickCard title="Operar con orden" text="Revisa datos antes de cambiar estados." />
          <QuickCard title="Contactar al cliente" text="Usa WhatsApp cuando falte pago, direccion o confirmacion." icon="message" />
          <QuickCard title="Cuidar permisos" text="Cada usuario debe usar su propia cuenta." icon="shield" />
        </div>
      </section>

      <section className="mt-5 grid gap-4 lg:grid-cols-2">
        {visibleBlocks.map((block) => (
          <Link key={block.title} href={block.href} className="rounded-lg border border-black/10 bg-white p-5 transition-colors hover:border-[#e4252c]">
            <p className="text-sm font-semibold uppercase text-[#e4252c]">{block.title}</p>
            <p className="mt-2 text-sm leading-6 text-black/60">{block.description}</p>
            <div className="mt-4 rounded-md bg-[#f4f4f5] p-3">
              <p className="text-sm font-semibold">Checklist rapido</p>
              <ol className="mt-2 space-y-1 text-sm leading-6 text-black/62">
                {block.checklist.map((item, index) => (
                  <li key={item}>
                    <span className="font-semibold text-black">{index + 1}. </span>
                    {item}
                  </li>
                ))}
              </ol>
            </div>
            <p className="mt-3 rounded-md border border-[#e4252c]/20 bg-[#fff1f2] p-3 text-sm leading-6 text-[#7f1d1d]">
              Evita: {block.avoid}
            </p>
          </Link>
        ))}
      </section>

      <section className="mt-5 rounded-lg border border-black/10 bg-white p-5">
        <p className="text-sm text-black/50">Recordatorios</p>
        <h2 className="mt-1 text-xl font-semibold">Dudas comunes durante el dia</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleTips.map((tip) => (
            <article key={tip.title} className="rounded-md bg-[#f4f4f5] p-4">
              <p className="font-semibold">{tip.title}</p>
              <p className="mt-2 text-sm leading-6 text-black/60">{tip.text}</p>
            </article>
          ))}
        </div>
      </section>
    </AdminShell>
  );
}

function QuickCard({ title, text, icon = "list" }: { title: string; text: string; icon?: "list" | "message" | "shield" }) {
  const Icon = icon === "message" ? MessageCircle : icon === "shield" ? ShieldCheck : ClipboardList;

  return (
    <article className="rounded-lg border border-black/10 p-4">
      <Icon size={20} className="text-[#e4252c]" />
      <p className="mt-3 font-semibold">{title}</p>
      <p className="mt-1 text-sm leading-6 text-black/60">{text}</p>
    </article>
  );
}
