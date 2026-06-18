import Link from "next/link";
import { CheckCircle2, Clock3, ExternalLink, FileCheck2, KeyRound, Scale, ShieldCheck } from "lucide-react";
import { AdminBackButton } from "@/components/admin/admin-back-button";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const checklistGroups = [
  {
    title: "Completado",
    status: "completed",
    items: [
      "Catálogo con productos y precios.",
      "Carrito de compras.",
      "Datos de contacto visibles.",
      "Políticas públicas de entrega, devoluciones, cancelación, privacidad y términos.",
      "Páginas informativas de pago: aprobado, rechazado, cancelado y pendiente.",
      "HTTPS/TLS activo en producción.",
    ],
  },
  {
    title: "No activo",
    status: "pending",
    items: [
      "No hay integración directa activa dentro del sitio.",
      "No hay proceso automático de pago activo para tarjeta.",
      "La tarjeta se gestiona mediante un enlace externo enviado manualmente por WhatsApp.",
      "La confirmación del pago se registra manualmente desde pedidos.",
    ],
  },
  {
    title: "Requiere datos reales",
    status: "real_data",
    items: [
      "Nombre legal del comercio.",
      "RTN y datos fiscales validados por contabilidad.",
      "Dirección, horario y contacto de servicio al cliente actualizados.",
      "Cuenta bancaria receptora y responsable de conciliación definidos.",
    ],
  },
  {
    title: "Referencia historica",
    status: "credentials",
    items: [
      "Esta sección queda como referencia futura no activa.",
      "No usar credenciales ni llaves bancarias para el flujo actual.",
      "No solicitar datos de tarjeta dentro del sitio.",
      "Confirmar pagos con tarjeta solo después de verificar el enlace externo.",
    ],
  },
  {
    title: "Requiere revisión legal/contable",
    status: "legal",
    items: [
      "Políticas revisadas por responsable legal/contable.",
      "Procedimiento de anulación, devolución y cancelación documentado.",
      "Tratamiento fiscal de envío y pago contra entrega validado.",
      "Responsable de conciliación bancaria asignado.",
    ],
  },
];

const publicRoutes = [
  ["/politicas", "Centro de políticas"],
  ["/terminos-y-condiciones", "Términos y condiciones"],
  ["/politica-de-privacidad", "Política de privacidad"],
  ["/politica-de-entrega", "Política de entrega"],
  ["/politica-de-devoluciones", "Política de devoluciones"],
  ["/politica-de-cancelacion", "Política de cancelación"],
  ["/contacto-servicio-cliente", "Servicio al cliente"],
  ["/pago/aprobado", "Pago aprobado"],
  ["/pago/rechazado", "Pago rechazado"],
  ["/pago/cancelado", "Pago cancelado"],
  ["/pago/pendiente", "Pago pendiente"],
];

export default async function RevisionBacPage() {
  const profile = await requirePermission("commercial_settings:manage");
  const canViewTechnical = profile.permissions.includes("technical:tools");
  const visibleChecklistGroups = canViewTechnical ? checklistGroups : checklistGroups.filter((group) => group.status !== "credentials");

  return (
    <AdminShell title="Tarjeta mediante enlace externo">
      <AdminBackButton />
      <section className="grid gap-6">
        <div className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-sm text-black/50">Flujo activo sin integración directa</p>
              <h1 className="mt-1 text-2xl font-semibold">Tarjeta mediante enlace de pago externo</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">
                El checkout no procesa tarjetas dentro del sitio. El equipo envía manualmente un enlace externo por
                WhatsApp y confirma el pago desde pedidos cuando lo verifica. El sistema no guarda números de tarjeta,
                CVV ni fecha de vencimiento.
              </p>
            </div>
            <span className="inline-flex w-fit items-center gap-2 rounded-md bg-[#ecfdf5] px-3 py-2 text-sm font-semibold text-[#166534]">
              <ShieldCheck size={17} />
              Datos de tarjeta fuera del sistema
            </span>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {visibleChecklistGroups.map((group) => (
            <ChecklistCard key={group.title} title={group.title} status={group.status} items={group.items} />
          ))}
        </div>

        <div className={`grid gap-4 ${canViewTechnical ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
          <InfoCard
            title="Flujo activo"
            text="Crear el pedido, enviar el enlace externo por WhatsApp, verificar el pago y confirmarlo manualmente desde Pedidos."
          />
          <InfoCard
            title="Qué no debe hacerse"
            text="No pedir datos de tarjeta en la web, no guardar CVV, no marcar pagos como confirmados sin verificación externa."
          />
          <InfoCard
            title="Confirmación manual"
            text="El dueño o el rol autorizado confirma o rechaza el pago después de revisar el resultado del enlace externo."
          />
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
          <h2 className="font-semibold">Rutas públicas para revisión</h2>
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {publicRoutes.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className="flex items-center justify-between gap-3 rounded-md border border-black/10 px-3 py-2 text-sm transition-colors hover:border-[#e4252c]"
              >
                <span>{label}</span>
                <ExternalLink size={15} className="text-[#e4252c]" />
              </Link>
            ))}
          </div>
        </div>

        {canViewTechnical ? <div className="rounded-lg border border-[#e4252c]/20 bg-[#fff1f2] p-5 text-sm leading-6 text-[#7f1d1d]">
          No hay credenciales bancarias activas para tarjeta dentro del sitio. Ningun usuario operativo debe ver o
          modificar API keys, secretos de cron ni configuración técnica sensible.
        </div> : null}
      </section>
    </AdminShell>
  );
}

function ChecklistCard({ title, items, status }: { title: string; items: string[]; status: string }) {
  const toneByStatus: Record<string, string> = {
    completed: "text-[#166534] bg-[#f0fdf4]",
    pending: "text-[#9b341b] bg-[#fff7ed]",
    real_data: "text-[#1d4ed8] bg-[#eff6ff]",
    credentials: "text-[#7c3aed] bg-[#f5f3ff]",
    legal: "text-[#7f1d1d] bg-[#fff1f2]",
  };
  const labelByStatus: Record<string, string> = {
    completed: "Completado",
    pending: "Pendiente",
    real_data: "Requiere datos reales",
    credentials: "Integración no activa",
    legal: "Revisión legal/contable",
  };
  const iconByStatus = {
    completed: CheckCircle2,
    pending: Clock3,
    real_data: FileCheck2,
    credentials: KeyRound,
    legal: Scale,
  };
  const Icon = iconByStatus[status as keyof typeof iconByStatus] ?? Clock3;

  return (
    <article className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        <span className={`rounded-md px-2.5 py-1 text-xs font-semibold ${toneByStatus[status]}`}>
          {labelByStatus[status]}
        </span>
      </div>
      <div className="mt-4 grid gap-2">
        {items.map((item) => (
          <div key={item} className="flex items-start gap-2 rounded-md bg-[#f4f4f5] px-3 py-2 text-sm">
            <Icon size={16} className="mt-0.5 text-black/55" />
            <span>{item}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function InfoCard({ title, text }: { title: string; text: string }) {
  return (
    <article className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-black/60">{text}</p>
    </article>
  );
}
