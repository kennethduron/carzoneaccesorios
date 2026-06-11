import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { BusinessContactCard } from "@/components/store/legal-page";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";
import { createPublicMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = createPublicMetadata({
  title: "Políticas de compra | Car Zone Accesorios",
  description: "Consulta las políticas de privacidad, entrega, devoluciones, cancelación y servicio al cliente de Car Zone Accesorios.",
  path: "/politicas",
  absoluteTitle: true,
});

const policyLinks = [
  {
    title: "Términos y condiciones",
    href: "/terminos-y-condiciones",
    description: "Condiciones generales de uso, pedidos, precios, pagos y facturación.",
  },
  {
    title: "Política de privacidad",
    href: "/politica-de-privacidad",
    description: "Uso de datos personales, seguridad y tratamiento de información de clientes.",
  },
  {
    title: "Política de entrega",
    href: "/politica-de-entrega",
    description: "Cobertura, tiempos de entrega, costos de envío y recepción de pedidos.",
  },
  {
    title: "Política de devoluciones",
    href: "/politica-de-devoluciones",
    description: "Condiciones base para cambios, devoluciones y revisión de productos.",
  },
  {
    title: "Política de cancelación",
    href: "/politica-de-cancelacion",
    description: "Reglas para cancelar pedidos pendientes, enviados o pagados.",
  },
  {
    title: "Servicio al cliente",
    href: "/contacto-servicio-cliente",
    description: "Canales oficiales de atención para soporte, pedidos y pagos.",
  },
];

export default async function PoliticasPage() {
  const settings = await getPublicCompanySettings();

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-6xl px-5 py-10">
        <p className="text-sm text-black/50">Informacion legal y comercial</p>
        <h1 className="mt-2 text-4xl font-semibold">Políticas de Car Zone Accesorios</h1>
        <p className="mt-4 max-w-3xl text-black/60">
          Estas páginas reúnen las condiciones comerciales visibles requeridas para operar una tienda en línea con pagos
          manuales y tarjeta por link externo.
        </p>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {policyLinks.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="group rounded-lg border border-black/10 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#e4252c] hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">{item.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-black/60">{item.description}</p>
                </div>
                <ArrowRight size={18} className="mt-1 shrink-0 text-[#e4252c] transition-transform group-hover:translate-x-1" />
              </div>
            </Link>
          ))}
        </div>

        <BusinessContactCard settings={settings} />
      </section>
    </PublicStoreShell>
  );
}
