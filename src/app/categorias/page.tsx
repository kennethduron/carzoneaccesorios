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

const expectedCategories = [
  ["Exterior", "exterior", "Carrocería, defensas, molduras y protección.", Wrench],
  ["Interior", "interior", "Comodidad, organización y acabado de cabina.", Car],
  ["Iluminación", "iluminacion", "LED, focos, neblineras y señalización.", Lightbulb],
  ["Audio", "audio", "Radios, bocinas, pantallas y accesorios.", Headphones],
  ["Motos", "motos", "Accesorios para motos y uso diario.", Sparkles],
  ["Aros y llantas", "aros-y-llantas", "Complementos para rueda y acabado exterior.", PackageCheck],
  ["Accesorios universales", "accesorios-universales", "Productos compatibles con múltiples vehículos.", PackageCheck],
  ["Por marca de vehículo", "", "Usa filtros por marca en el catálogo.", Car],
  ["Por modelo de vehículo", "", "Combina marca, modelo y año.", Car],
] as const;

export default async function CategoriasPage() {
  const categories = await getCategorySummaries();
  const activeSlugs = new Set(categories.map((category) => category.slug));
  const extraCategories = categories.filter((category) => !expectedCategories.some((item) => item[1] === category.slug));

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-7xl px-4 py-8 sm:px-5">
        <p className="text-sm font-medium uppercase text-[#e4252c]">Explora por línea</p>
        <h1 className="mt-2 text-4xl font-semibold">Categorías</h1>
        <p className="mt-3 max-w-2xl text-sm text-black/58">
          Organización pensada para una tienda automotriz: por línea de producto y por compatibilidad de vehículo.
        </p>

        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3">
          {expectedCategories.map(([name, slug, description, Icon]) => {
            const href = slug ? `/catalogo?categoria=${encodeURIComponent(slug)}` : "/catalogo";
            const active = slug ? activeSlugs.has(slug) : true;

            return (
              <Link
                key={name}
                href={href}
                className="rounded-lg border border-black/10 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:shadow-md"
              >
                <Icon size={22} className="mb-3 text-[#e4252c]" />
                <p className="text-sm font-semibold sm:text-lg">{name}</p>
                <p className="mt-1 hidden text-sm text-black/55 sm:block">{description}</p>
                <p className="mt-3 text-xs font-medium text-black/45">{active ? "Ver productos" : "Preparada para activar"}</p>
              </Link>
            );
          })}
        </div>

        {extraCategories.length > 0 ? (
          <div className="mt-8">
            <h2 className="text-2xl font-semibold">Otras categorías activas</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {extraCategories.map((category) => (
                <Link
                  key={category.name}
                  href={`/catalogo?categoria=${encodeURIComponent(category.slug)}`}
                  className="rounded-lg border border-black/10 bg-white p-5 transition-colors hover:border-[#e4252c]"
                >
                  <p className="text-xl font-semibold">{category.name}</p>
                  <p className="mt-2 text-sm text-black/55">Ver productos disponibles</p>
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </PublicStoreShell>
  );
}
