import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BadgePercent,
  Car,
  Headphones,
  Lightbulb,
  PackageCheck,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Truck,
  Wrench,
} from "lucide-react";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CatalogProductCard } from "@/components/store/catalog-product-card";
import { WholesaleCodePanel } from "@/components/store/wholesale-code-panel";
import { HolidayBannerPopup } from "@/components/store/holiday-banner-popup";
import { SocialLinks, hasSocialLinks } from "@/components/store/social-links";
import { getActiveHolidayBanner } from "@/services/supabase/holiday-banners.service";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";
import { getFeaturedProducts } from "@/services/supabase/products.service";

export const dynamic = "force-dynamic";

const categoryTiles = [
  ["Exterior", "Defensas, molduras, parrillas y proteccion", Wrench, "/catalogo?categoria=exterior"],
  ["Interior", "Organizacion, comodidad y estilo de cabina", Car, "/catalogo?categoria=interior"],
  ["Iluminacion", "LED, halogenos, neblineras y senalizacion", Lightbulb, "/catalogo?categoria=iluminacion"],
  ["Audio", "Bocinas, radios, pantallas y cableado", Headphones, "/catalogo?categoria=audio"],
  ["Motos", "Accesorios y repuestos para motos", Sparkles, "/catalogo?categoria=motos"],
  ["Aros y llantas", "Complementos para rueda y acabado", BadgePercent, "/catalogo?categoria=aros-y-llantas"],
  ["Universales", "Accesorios para multiples vehiculos", PackageCheck, "/catalogo?categoria=accesorios-universales"],
  ["Por vehiculo", "Filtra por marca, modelo y anio", Car, "/catalogo"],
] as const;

export default async function HomePage() {
  const [featuredProducts, holidayBanner, companySettings] = await Promise.all([
    getFeaturedProducts(6),
    getActiveHolidayBanner(),
    getPublicCompanySettings(),
  ]);

  return (
    <PublicStoreShell>
      <HolidayBannerPopup banner={holidayBanner} />
      <section className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-5 lg:grid-cols-[1.08fr_0.92fr] lg:items-stretch">
        <div className="relative flex min-h-[500px] flex-col justify-between overflow-hidden rounded-lg bg-[#080808] p-6 text-white shadow-xl shadow-black/20 md:p-8">
          <Image
            src="https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1400&q=80"
            alt="Vehiculo equipado con accesorios Car Zone"
            fill
            preload
            sizes="(min-width: 1024px) 58vw, 100vw"
            className="object-cover opacity-45"
          />
          <div className="absolute inset-x-0 bottom-0 h-32 bg-[#e4252c]/90" aria-hidden="true" />
          <div className="relative">
            <p className="mb-4 inline-flex items-center gap-2 rounded-md bg-white/12 px-3 py-1 text-sm">
              <ShieldCheck size={16} />
              Tienda automotriz con detalle, mayoreo e inventario
            </p>
            <h1 className="max-w-3xl text-4xl font-semibold leading-tight md:text-6xl">
              Accesorios para equipar, renovar y vender mejor.
            </h1>
            <p className="mt-5 max-w-2xl text-white/78">
              Compra por categoria, por compatibilidad de vehiculo o con precio mayorista activo en todo el flujo.
            </p>
          </div>
          <div className="relative mt-8 flex flex-wrap gap-3">
            <Link
              href="/catalogo"
              className="inline-flex items-center gap-2 rounded-md bg-white px-4 py-3 text-sm font-semibold text-[#080808] transition-all hover:-translate-y-0.5 hover:bg-[#fff1f2]"
            >
              Comprar ahora
              <ShoppingCart size={17} />
            </Link>
            <Link
              href="/contacto#mayoreo"
              className="inline-flex items-center gap-2 rounded-md border border-white/25 px-4 py-3 text-sm font-semibold text-white transition-all hover:-translate-y-0.5 hover:border-white/45 hover:bg-white/10"
            >
              Solicitar mayoreo
              <ArrowRight size={17} />
            </Link>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          {[
            ["Promociones listas", "Encuentra ofertas, productos nuevos y articulos de alta rotacion.", BadgePercent],
            ["Entrega organizada", "Pedidos con control de stock, seguimiento y soporte al cliente.", Truck],
            ["Pago seguro", "Transferencia, efectivo y tarjeta BAC preparada para activacion.", ShieldCheck],
          ].map(([title, text, Icon]) => (
            <article key={title as string} className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
              <Icon size={22} className="mb-4 text-[#e4252c]" />
              <h2 className="font-semibold">{title as string}</h2>
              <p className="mt-2 text-sm text-black/58">{text as string}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-8 sm:px-5">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium uppercase text-[#e4252c]">Compra por categoria</p>
            <h2 className="mt-1 text-2xl font-semibold">Categorias automotrices</h2>
          </div>
          <Link href="/categorias" className="hidden text-sm font-medium text-[#e4252c] hover:text-[#b91c25] sm:inline">
            Ver categorias
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {categoryTiles.map(([title, text, Icon, href]) => (
            <Link
              key={title}
              href={href}
              className="rounded-lg border border-black/10 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:shadow-md"
            >
              <Icon size={22} className="mb-3 text-[#e4252c]" />
              <h3 className="text-sm font-semibold sm:text-base">{title}</h3>
              <p className="mt-1 hidden text-sm text-black/55 sm:block">{text}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-4 pb-10 sm:px-5 lg:grid-cols-[1fr_340px]">
        <div>
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium uppercase text-[#e4252c]">Inventario activo</p>
              <h2 className="text-2xl font-semibold">Productos destacados</h2>
            </div>
            <Link href="/catalogo" className="text-sm font-medium text-[#e4252c] transition-colors hover:text-[#b91c25]">
              Ver todos
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-3">
            {featuredProducts.map((product) => (
              <CatalogProductCard key={product.id} product={product} />
            ))}
          </div>
        </div>
        <WholesaleCodePanel />
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-10 sm:px-5">
        <div className="grid gap-3 rounded-lg border border-black/10 bg-white p-5 shadow-sm md:grid-cols-4">
          {[
            ["HTTPS", "Conexion segura para navegar y comprar."],
            ["Pago seguro", "No guardamos datos de tarjeta."],
            ["Politicas visibles", "Entrega, devoluciones y cancelacion."],
            ["Soporte", "Contacto rapido por canales oficiales."],
          ].map(([title, text]) => (
            <div key={title}>
              <p className="font-semibold">{title}</p>
              <p className="mt-1 text-sm text-black/58">{text}</p>
            </div>
          ))}
        </div>
      </section>

      {hasSocialLinks(companySettings) ? (
        <section className="mx-auto max-w-7xl px-4 pb-10 sm:px-5">
          <div className="rounded-lg border border-black/10 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md sm:flex sm:items-center sm:justify-between sm:gap-6">
            <div>
              <h2 className="text-xl font-semibold">Conecta con Car Zone</h2>
              <p className="mt-1 text-sm text-black/55">Siguenos y escribenos por nuestros canales oficiales.</p>
            </div>
            <div className="mt-4 sm:mt-0">
              <SocialLinks settings={companySettings} variant="home" />
            </div>
          </div>
        </section>
      ) : null}
    </PublicStoreShell>
  );
}
