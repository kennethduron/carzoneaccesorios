import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2, Clock3, ExternalLink, ShieldCheck } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const completedItems = [
  "Catálogo con productos y precios",
  "Carrito de compras",
  "Datos de contacto visibles",
  "Política de entrega",
  "Política de devoluciones",
  "Política de cancelación",
  "Términos y condiciones",
  "Política de privacidad",
  "Logos o identificadores de tarjetas aceptadas",
  "Páginas de resultado de pago",
];

const pendingItems = [
  "Código oficial de integración BAC",
  "Credenciales productivas de la pasarela",
  "Webhook seguro con validación de firma/respuesta bancaria",
  "3D Secure según documentación final de BAC",
  "Prueba bancaria de aprobación, rechazo, cancelación y pendiente",
];

const commerceDataItems = [
  "Nombre legal del comercio confirmado",
  "RTN y datos fiscales validados por contabilidad",
  "Dirección, horario y contacto de servicio al cliente actualizados",
  "Cuenta bancaria receptora y responsables internos definidos",
];

const legalReviewItems = [
  "Políticas revisadas por responsable legal/contable",
  "Procedimiento de anulación, devolución y cancelación documentado",
  "Criterio fiscal para comisión por pago contra entrega validado",
  "Responsable de conciliación bancaria asignado",
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
  const profile = await requirePermission("admin:access");

  if (profile.role !== "admin") {
    redirect("/sin-permiso");
  }

  return (
    <AdminShell title="Revisión BAC Credomatic">
      <section className="grid gap-6">
        <div className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-sm text-black/50">Checklist previo a pasarela</p>
              <h1 className="mt-1 text-2xl font-semibold">Requisitos web para BAC Credomatic Honduras</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">
                Esta pantalla resume los elementos visibles que la web debe presentar antes de activar el código real de
                la pasarela. No se almacenan números de tarjeta, CVV ni fecha de vencimiento en Supabase.
              </p>
            </div>
            <span className="inline-flex w-fit items-center gap-2 rounded-md bg-[#fff7ed] px-3 py-2 text-sm font-semibold text-[#9b341b]">
              <ShieldCheck size={17} />
              HTTPS/TLS requerido en producción
            </span>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChecklistCard title="Completado en la web" items={completedItems} status="completed" />
          <ChecklistCard title="Pendiente de BAC/documentación" items={pendingItems} status="pending" />
          <ChecklistCard title="Requiere datos del comercio" items={commerceDataItems} status="pending" />
          <ChecklistCard title="Requiere revisión legal/contable" items={legalReviewItems} status="pending" />
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

        <div className="rounded-lg border border-[#e4252c]/20 bg-[#fff1f2] p-5 text-sm leading-6 text-[#7f1d1d]">
          La integración final debe validar respuestas de BAC en backend, usar variables sensibles solo en Vercel y
          confirmar 3D Secure si BAC lo exige. No se debe simular 3D Secure sin documentación oficial.
        </div>
      </section>
    </AdminShell>
  );
}

function ChecklistCard({
  title,
  items,
  status,
}: {
  title: string;
  items: string[];
  status: "completed" | "pending";
}) {
  const Icon = status === "completed" ? CheckCircle2 : Clock3;
  const badge = status === "completed" ? "Completado" : "Pendiente";
  const tone = status === "completed" ? "text-[#166534] bg-[#f0fdf4]" : "text-[#9b341b] bg-[#fff7ed]";

  return (
    <article className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        <span className={`rounded-md px-2.5 py-1 text-xs font-semibold ${tone}`}>{badge}</span>
      </div>
      <div className="mt-4 grid gap-2">
        {items.map((item) => (
          <div key={item} className="flex items-start gap-2 rounded-md bg-[#f4f4f5] px-3 py-2 text-sm">
            <Icon size={16} className={status === "completed" ? "mt-0.5 text-[#166534]" : "mt-0.5 text-[#9b341b]"} />
            <span>{item}</span>
          </div>
        ))}
      </div>
    </article>
  );
}
