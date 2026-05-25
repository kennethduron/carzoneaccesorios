import type { Metadata } from "next";
import Link from "next/link";
import { Car, Headphones, Lightbulb, PackageCheck, Sparkles, Wrench } from "lucide-react";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { getCategorySummaries } from "@/services/supabase/products.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Categorías",
  description:
    "Categorías preparadas para accesorios automotrices por línea de producto, compatibilidad de vehículo y necesidades de compra.",
  alternates: {
    canonical: "/categorias",
  },
  openGraph: {
    title: "Categorías | Car Zone Accesorios",
    description: "Explora accesorios automotrices por categoría y compatibilidad.",
    url: "/categorias",
  },
};

const categoryPresentation = {
  exterior: ["Carrocería, defensas, molduras y protección.", Wrench],
  interior: ["Comodidad, organización y acabado de cabina.", Car],
  iluminacion: ["LED, focos, neblineras y señalización.", Lightbulb],
  luces: ["LED, focos, neblineras y señalización.", Lightbulb],
  audio: ["Radios, bocinas, pantallas y accesorios.", Headphones],
  motos: ["Accesorios para motos y uso diario.", Sparkles],
  "aros-y-llantas": ["Complementos para rueda y acabado exterior.", PackageCheck],
  accesorios: ["Productos compatibles con múltiples vehículos.", PackageCheck],
  "accesorios-universales": ["Productos compatibles con múltiples vehículos.", PackageCheck],
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
