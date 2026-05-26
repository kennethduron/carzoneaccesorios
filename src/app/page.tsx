import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BadgePercent,
  Car,
  Cpu,
  CreditCard,
  Gauge,
  Headphones,
  Lightbulb,
  MessageCircle,
  PackageCheck,
  Radar,
  ReceiptText,
  Search,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Wrench,
} from "lucide-react";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CatalogProductCard } from "@/components/store/catalog-product-card";
import { WholesaleCodePanel } from "@/components/store/wholesale-code-panel";
import { HolidayBannerPopup } from "@/components/store/holiday-banner-popup";
import { SocialLinks, hasSocialLinks } from "@/components/store/social-links";
import { getActiveHolidayBanners } from "@/services/supabase/holiday-banners.service";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";
import { getCategorySummaries, getCompatibilityBrandSummaries, getFeaturedProducts } from "@/services/supabase/products.service";

export const dynamic = "force-dynamic";

const categoryPresentation = {
  seguridad: ["Protección, visibilidad y control para manejar con confianza.", ShieldCheck],
  tecnologia: ["Pantallas, sensores, cámaras y accesorios inteligentes.", Cpu],
  herramientas: ["Equipo útil para mantenimiento, instalación y emergencia.", Wrench],
  iluminacion: ["LED, halógenos, neblineras y señalización.", Lightbulb],
  luces: ["LED, halógenos, neblineras y señalización.", Lightbulb],
  interior: ["Comodidad, organización y detalles para cabina.", Car],
  exterior: ["Estilo, protección y presencia para tu vehículo.", Gauge],
  audio: ["Bocinas, radios, pantallas y cableado.", Headphones],
  accesorios: ["Productos universales y complementos de uso diario.", PackageCheck],
  "accesorios-universales": ["Productos universales y complementos de uso diario.", PackageCheck],
} as const;

const fallbackCompatibilityBrands = ["Toyota", "Honda", "Nissan", "Mazda", "Mitsubishi", "Chevrolet", "Kia", "Volkswagen", "Hyundai"];

const trustBlocks = [
  ["Compra rápida", "Busca por categoría, SKU o compatibilidad y agrega al carrito en segundos.", ShoppingCart],
  ["Atención por WhatsApp", "Consulta disponibilidad, compatibilidad o mayoreo con soporte comercial.", MessageCircle],
  ["Detalle y mayoreo", "Precio público y precio mayorista para cuentas aprobadas.", BadgePercent],
  ["Rastreo de pedido", "Seguimiento simple para saber en qué etapa va tu compra.", Radar],
  ["Facturación disponible", "Facturas fiscales y datos de compra organizados.", ReceiptText],
  ["Pagos seguros", "Flujo preparado para transferencias, efectivo y tarjeta.", CreditCard],
] as const;

export default async function HomePage() {
  const [featuredProducts, holidayBanners, companySettings, categories, compatibilityBrands] = await Promise.all([
    getFeaturedProducts(6),
    getActiveHolidayBanners(4),
    getPublicCompanySettings(),
    getCategorySummaries(),
    getCompatibilityBrandSummaries(9),
  ]);
  const featuredCategories = categories.slice(0, 8);
  const brandTiles = compatibilityBrands.length > 0 ? compatibilityBrands : fallbackCompatibilityBrands;

  return (
    <PublicStoreShell>
      <HolidayBannerPopup banners={holidayBanners} />
      <section className="relative isolate min-h-[560px] overflow-hidden bg-[#080808] text-white sm:min-h-[590px] lg:min-h-[620px]">
        <Image
          src="https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1800&q=78"
          alt="Vehículo en carretera con estilo automotriz"
          fill
          preload
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-[#080808]/42 sm:bg-[#080808]/22" aria-hidden="true" />
        <div className="absolute inset-0 bg-linear-to-r from-[#080808]/78 via-[#080808]/46 to-[#080808]/12 sm:from-[#080808]/68 sm:via-[#080808]/30 sm:to-[#080808]/6" aria-hidden="true" />
        <div className="absolute inset-x-0 bottom-0 h-28 bg-linear-to-t from-[#f4f4f5] to-transparent" aria-hidden="true" />

        <div className="relative mx-auto flex min-h-[560px] max-w-7xl flex-col justify-center px-4 py-8 sm:min-h-[590px] sm:px-5 lg:min-h-[620px] lg:py-10">
          <div className="max-w-3xl">
            <p className="inline-flex items-center gap-2 rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white/90 backdrop-blur">
              <Sparkles size={16} />
              Car Zone Accesorios
            </p>
            <h1 className="mt-4 max-w-[780px] text-3xl font-semibold leading-[1.08] sm:text-4xl sm:leading-[1.06] lg:text-5xl xl:text-6xl">
              Accesorios automotrices para llevar tu vehículo al siguiente nivel
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-white/80 sm:text-lg">
              Compra al detalle o solicita acceso mayorista. Encuentra productos para seguridad, comodidad, tecnología y estilo.
            </p>
            <form action="/catalogo" className="mt-6 flex max-w-2xl flex-col gap-2 rounded-lg border border-white/18 bg-white/12 p-2 backdrop-blur sm:flex-row">
              <label className="flex min-h-12 flex-1 items-center gap-2 rounded-md bg-white px-3 text-black">
                <Search size={18} className="text-black/45" />
                <input
                  name="q"
                  placeholder="Busca por producto, SKU, categoría o vehículo"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-black/45"
                />
              </label>
              <button className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-[#e4252c] px-5 text-sm font-semibold text-white transition-all hover:bg-[#b91c25]">
                Buscar
                <ArrowRight size={18} />
              </button>
            </form>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/catalogo"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-[#e4252c] px-5 text-sm font-semibold text-white shadow-lg shadow-[#e4252c]/25 transition-all hover:-translate-y-0.5 hover:bg-[#b91c25]"
              >
                Ver catálogo
                <ShoppingCart size={18} />
              </Link>
              <Link
                href="/contacto#mayoreo"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-white/25 bg-white/10 px-5 text-sm font-semibold text-white backdrop-blur transition-all hover:-translate-y-0.5 hover:border-white/45 hover:bg-white/15"
              >
                Solicitar mayoreo
                <ArrowRight size={18} />
              </Link>
            </div>
          </div>

          <div className="mt-8 grid max-w-2xl grid-cols-3 gap-3 text-sm sm:grid-cols-3 lg:mt-9">
            {[
              ["Detalle", "Compra rápida"],
              ["Mayoreo", "Cuentas aprobadas"],
              ["Rastreo", "Pedido visible"],
            ].map(([title, text]) => (
              <div key={title} className="border-l border-white/25 pl-3">
                <p className="font-semibold">{title}</p>
                <p className="mt-1 text-white/62">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-6 sm:px-5">
        <div className="flex flex-col gap-4 border-b border-black/10 pb-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm font-medium uppercase text-[#e4252c]">Busca por compatibilidad</p>
            <h2 className="mt-1 text-2xl font-semibold">Marcas de vehículo frecuentes</h2>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:flex lg:flex-wrap lg:justify-end">
            {brandTiles.map((brand) => (
              <Link
                key={brand}
                href={`/catalogo?marca_carro=${encodeURIComponent(brand)}`}
                className="inline-flex min-h-10 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-sm font-semibold text-black/70 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:text-[#b91c25]"
              >
                {brand}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-8 sm:px-5">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium uppercase text-[#e4252c]">Compra por categoría</p>
            <h2 className="mt-1 text-2xl font-semibold">Categorías destacadas</h2>
          </div>
          <Link href="/categorias" className="hidden text-sm font-medium text-[#e4252c] hover:text-[#b91c25] sm:inline">
            Ver categorías
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {featuredCategories.map((category) => {
            const [text, Icon] =
              categoryPresentation[category.slug as keyof typeof categoryPresentation] ?? ["Productos disponibles en esta línea.", PackageCheck];

            return (
              <Link
                key={category.slug}
                href={`/catalogo?categoria=${encodeURIComponent(category.slug)}`}
                className="rounded-lg border border-black/10 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:shadow-md"
              >
                <span className="mb-3 grid size-10 place-items-center rounded-md bg-[#fff1f2] text-[#b91c25]">
                  <Icon size={21} />
                </span>
                <h3 className="text-sm font-semibold sm:text-base">{category.name}</h3>
                <p className="mt-1 hidden text-sm text-black/55 sm:block">{text}</p>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-10 sm:px-5">
        <div className="mb-4">
          <p className="text-sm font-medium uppercase text-[#e4252c]">Operación confiable</p>
          <h2 className="mt-1 text-2xl font-semibold">Compra con soporte de principio a fin</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {trustBlocks.map(([title, text, Icon]) => (
            <article key={title} className="rounded-lg border border-black/10 bg-white p-4 shadow-sm">
              <Icon size={21} className="text-[#e4252c]" />
              <h3 className="mt-3 font-semibold">{title}</h3>
              <p className="mt-1 text-sm leading-6 text-black/58">{text}</p>
            </article>
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
            ["HTTPS", "Conexión segura para navegar y comprar."],
            ["Pago seguro", "No guardamos datos de tarjeta."],
            ["Políticas visibles", "Entrega, devoluciones y cancelación."],
            ["Soporte", "Contacto rápido por canales oficiales."],
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
              <p className="mt-1 text-sm text-black/55">Síguenos y escríbenos por nuestros canales oficiales.</p>
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
