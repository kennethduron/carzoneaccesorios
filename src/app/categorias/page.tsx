import type { Metadata } from "next";
import Link from "next/link";
import { Car, Headphones, Lightbulb, PackageCheck, ShieldCheck, Wrench } from "lucide-react";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { createPublicMetadata } from "@/lib/seo";
import { getCategorySummaries } from "@/services/supabase/products.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = createPublicMetadata({
  title: "Categorías de accesorios automotrices | Car Zone Accesorios",
  description: "Explora categorías de accesorios para carros, audio, luces LED y seguridad vehicular disponibles en Honduras.",
  path: "/categorias",
  absoluteTitle: true,
});

const categoryPresentation = {
  exterior: ["Estilo, protección y accesorios para el exterior.", PackageCheck],
  interior: ["Comodidad, organización y acabado de cabina.", Car],
  iluminacion: ["LED, focos, neblineras y señalización.", Lightbulb],
  "polarizado-y-herramientas": ["Polarizado, instalación y equipo especializado.", Wrench],
  carroceria: ["Piezas, molduras y elementos para la carrocería.", Car],
  seguridad: ["Protección, visibilidad y control para tu vehículo.", ShieldCheck],
  "audio-y-sonido": ["Radios, bocinas, pantallas y accesorios de sonido.", Headphones],
} as const;

export default async function CategoriasPage() {
  const categories = await getCategorySummaries();

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-7xl px-4 py-8 sm:px-5">
        <p className="text-sm font-medium uppercase text-[#e4252c]">Explora por línea</p>
        <h1 className="mt-2 text-4xl font-semibold">Categorías</h1>
        <p className="mt-3 max-w-2xl text-sm text-black/58">
          Organización pensada para una tienda automotriz: por línea de producto y por compatibilidad de vehículo.
        </p>

        {categories.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-black/15 bg-white p-8 text-center">
            <h2 className="text-xl font-semibold">Todavía no hay categorías activas.</h2>
            <p className="mt-2 text-sm text-black/55">Cuando se activen categorías en el CRM, aparecerán aquí automáticamente.</p>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3">
            {categories.map((category) => {
              const [description, Icon] =
                categoryPresentation[category.slug as keyof typeof categoryPresentation] ?? ["Ver productos disponibles en esta categoría.", PackageCheck];

              return (
                <Link
                  key={category.slug}
                  href={`/catalogo?categoria=${encodeURIComponent(category.slug)}`}
                  className="rounded-lg border border-black/10 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:shadow-md"
                >
                  <Icon size={22} className="mb-3 text-[#e4252c]" />
                  <p className="text-sm font-semibold sm:text-lg">{category.name}</p>
                  <p className="mt-1 hidden text-sm text-black/55 sm:block">{description}</p>
                  <p className="mt-3 text-xs font-medium text-black/45">Ver productos</p>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </PublicStoreShell>
  );
}
