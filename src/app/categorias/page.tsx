import Link from "next/link";
import { Car, Headphones, Lightbulb, PackageCheck, Sparkles, Wrench } from "lucide-react";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { getCategorySummaries } from "@/services/supabase/products.service";

export const dynamic = "force-dynamic";

const expectedCategories = [
  ["Exterior", "exterior", "Carroceria, defensas, molduras y proteccion.", Wrench],
  ["Interior", "interior", "Comodidad, organizacion y acabado de cabina.", Car],
  ["Iluminacion", "iluminacion", "LED, focos, neblineras y senalizacion.", Lightbulb],
  ["Audio", "audio", "Radios, bocinas, pantallas y accesorios.", Headphones],
  ["Motos", "motos", "Accesorios para motos y uso diario.", Sparkles],
  ["Aros y llantas", "aros-y-llantas", "Complementos para rueda y acabado exterior.", PackageCheck],
  ["Accesorios universales", "accesorios-universales", "Productos compatibles con multiples vehiculos.", PackageCheck],
  ["Por marca de vehiculo", "", "Usa filtros por marca en el catalogo.", Car],
  ["Por modelo de vehiculo", "", "Combina marca, modelo y anio.", Car],
] as const;

export default async function CategoriasPage() {
  const categories = await getCategorySummaries();
  const activeSlugs = new Set(categories.map((category) => category.slug));
  const extraCategories = categories.filter((category) => !expectedCategories.some((item) => item[1] === category.slug));

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-7xl px-4 py-8 sm:px-5">
        <p className="text-sm font-medium uppercase text-[#e4252c]">Explora por linea</p>
        <h1 className="mt-2 text-4xl font-semibold">Categorias</h1>
        <p className="mt-3 max-w-2xl text-sm text-black/58">
          Organizacion pensada para una tienda automotriz: por linea de producto y por compatibilidad de vehiculo.
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
            <h2 className="text-2xl font-semibold">Otras categorias activas</h2>
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
