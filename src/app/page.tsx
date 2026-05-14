import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ShieldCheck, Truck } from "lucide-react";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CatalogProductCard } from "@/components/store/catalog-product-card";
import { WholesaleCodePanel } from "@/components/store/wholesale-code-panel";
import { HolidayBannerPopup } from "@/components/store/holiday-banner-popup";
import { getActiveHolidayBanner } from "@/services/supabase/holiday-banners.service";
import { getFeaturedProducts } from "@/services/supabase/products.service";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [featuredProducts, holidayBanner] = await Promise.all([getFeaturedProducts(3), getActiveHolidayBanner()]);

  return (
    <PublicStoreShell>
      <HolidayBannerPopup banner={holidayBanner} />
      <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-stretch">
        <div className="relative flex min-h-[520px] flex-col justify-between overflow-hidden rounded-lg bg-[#080808] p-6 text-white shadow-xl shadow-black/20 md:p-8">
          <div className="absolute inset-x-0 bottom-0 h-28 bg-[#e4252c]" aria-hidden="true" />
          <div className="absolute -right-20 top-16 h-64 w-64 rounded-full border border-white/10" aria-hidden="true" />
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-md bg-white/10 px-3 py-1 text-sm">
              <ShieldCheck size={16} />
              Precios al detalle y mayoristas reales
            </p>
            <h1 className="max-w-3xl text-4xl font-semibold leading-tight md:text-6xl">
              Accesorios automotrices listos para vender, instalar y despachar.
            </h1>
            <p className="mt-5 max-w-2xl text-white/70">
              Compra al detalle o activa tu código mayorista para trabajar con precio mayorista en todo el flujo.
            </p>
          </div>
          <div className="relative mt-8 flex flex-wrap gap-3">
            <Link href="/catalogo" className="inline-flex items-center gap-2 rounded-md bg-white px-4 py-3 text-sm font-semibold text-[#080808]">
              Ver catálogo
              <ArrowRight size={17} />
            </Link>
            <Link href="/contacto" className="inline-flex items-center gap-2 rounded-md border border-white/20 px-4 py-3 text-sm font-semibold text-white">
              Solicitar mayoreo
            </Link>
          </div>
        </div>
        <Image
          src="https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1200&q=80"
          alt="Auto deportivo para Car Zone Accesorios"
          width={1200}
          height={900}
          priority
          className="min-h-[360px] rounded-lg object-cover lg:h-full"
        />
      </section>

      <section className="mx-auto grid max-w-7xl gap-4 px-5 pb-8 md:grid-cols-3">
        {[
          ["Catálogo completo", "Iluminación, seguridad, interior, exterior, tecnología y herramientas."],
          ["Despacho organizado", "Pedidos preparados con seguimiento y control de inventario."],
          ["Mayoreo profesional", "Un código válido cambia todo el sistema a precio mayorista."],
        ].map(([title, text]) => (
          <article key={title} className="rounded-lg border border-black/10 bg-white p-5">
            <Truck size={20} className="mb-4 text-[#e4252c]" />
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-2 text-sm text-black/55">{text}</p>
          </article>
        ))}
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-5 pb-10 lg:grid-cols-[1fr_360px]">
        <div>
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-2xl font-semibold">Productos destacados</h2>
            <Link href="/catalogo" className="text-sm font-medium text-[#e4252c]">
              Ver todos
            </Link>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {featuredProducts.map((product) => (
              <CatalogProductCard key={product.id} product={product} />
            ))}
          </div>
        </div>
        <WholesaleCodePanel />
      </section>
    </PublicStoreShell>
  );
}

