"use client";

import { useEffect } from "react";
import Link from "next/link";
import { PackageCheck, ShieldCheck, ShoppingCart, Truck } from "lucide-react";
import { FaWhatsapp } from "react-icons/fa";
import type { Product } from "@/types/commerce";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";
import { useProductRegistry } from "@/contexts/product-registry-context";
import { formatCurrency, getProductPrice, getProductPriceLabel, hasValidWholesalePrice } from "@/utils/pricing";
import { getProductCardDescription, parseProductLines } from "@/utils/product-content";
import { getWholesaleMinimumQuantity } from "@/utils/wholesale-quantity";
import { ProductImageGallery } from "@/components/store/product-image-gallery";
import { CatalogProductCard } from "@/components/store/catalog-product-card";
import { buildWhatsAppMessageUrl } from "@/utils/contact-settings";

export function ProductDetail({
  product,
  relatedProducts = [],
  whatsappUrl = "",
  productUrl,
}: {
  product: Product;
  relatedProducts?: Product[];
  whatsappUrl?: string;
  productUrl: string;
}) {
  const { priceMode } = usePriceMode();
  const { addToCart, cartMessage } = useShoppingCart();
  const { registerProducts } = useProductRegistry();
  const compatibility = formatCompatibility(product);
  const summary = getProductCardDescription(product);
  const featureLines = parseProductLines(product.features);
  const specificationLines = parseProductLines(product.specifications);
  const compatibilityNotes = product.compatibility_notes?.trim();
  const whatsappMessage = product.sku?.trim()
    ? `Hola, estoy interesado en este producto: ${product.name} (SKU: ${product.sku}) - ${productUrl}`
    : `Hola, estoy interesado en este producto: ${product.name} - ${productUrl}`;
  const productWhatsappUrl = buildWhatsAppMessageUrl(whatsappUrl, whatsappMessage);
  const hasWholesalePrice = hasValidWholesalePrice(product);
  const isWholesalePriceVisible = priceMode === "wholesale" && hasWholesalePrice;
  const wholesaleMinimumQuantity = getWholesaleMinimumQuantity(product);
  const displayPrice = getProductPrice(product, priceMode);
  const priceLabel =
    priceMode === "wholesale" ? (hasWholesalePrice ? "Precio mayorista" : "Precio disponible") : getProductPriceLabel(product, priceMode);

  useEffect(() => {
    registerProducts([product, ...relatedProducts]);
  }, [product, relatedProducts, registerProducts]);

  return (
    <>
      <section className="mx-auto grid max-w-7xl gap-8 px-4 py-6 sm:px-5 lg:grid-cols-[0.95fr_1.05fr]">
        <ProductImageGallery product={product} />
        <div className="space-y-5">
          <Link href="/catalogo" className="text-sm font-medium text-[#e4252c]">
            Volver al catálogo
          </Link>
          <div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-md bg-[#f4f4f5] px-2 py-1 text-xs font-semibold uppercase text-black/55">{product.sku}</span>
              <span className="rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-semibold uppercase text-[#b91c25]">{product.category}</span>
              {product.is_new ? (
                <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold uppercase text-black/70">Nuevo</span>
              ) : null}
              {isWholesalePriceVisible ? (
                <span className="rounded-md bg-[#080808] px-2 py-1 text-xs font-semibold uppercase text-white">Precio mayorista</span>
              ) : null}
            </div>
            <h1 className="mt-3 text-3xl font-semibold leading-tight md:text-5xl">{product.name}</h1>
            {summary ? <p className="mt-4 text-lg leading-relaxed text-black/65">{summary}</p> : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-black/10 bg-white p-4">
              <p className="text-sm text-black/45">{priceLabel}</p>
              <p className="mt-1 text-3xl font-semibold">{formatCurrency(displayPrice)}</p>
              {!isWholesalePriceVisible && priceMode === "retail" ? (
                <p className="mt-1 text-sm text-black/55">Precio público del catálogo</p>
              ) : null}
              {isWholesalePriceVisible && wholesaleMinimumQuantity > 1 ? (
                <p className="mt-2 text-sm font-semibold text-[#9b341b]">Mínimo mayorista: {wholesaleMinimumQuantity} unidades</p>
              ) : null}
            </div>
            {isWholesalePriceVisible ? (
              <div className="rounded-lg border border-black/10 bg-white p-4">
                <p className="text-sm text-black/45">Mayoreo activo</p>
                <p className="mt-1 text-lg font-semibold">Precio especial aplicado</p>
                <p className="mt-2 text-sm text-black/55">
                  {wholesaleMinimumQuantity > 1
                    ? `Este producto requiere mínimo ${wholesaleMinimumQuantity} unidades para precio mayorista.`
                    : "El carrito y checkout usarán este mismo precio."}
                </p>
              </div>
            ) : priceMode === "retail" ? (
              <div className="rounded-lg border border-black/10 bg-white p-4">
                <p className="text-sm text-black/45">Acceso mayorista</p>
                <p className="mt-1 text-lg font-semibold">Disponible para cuentas aprobadas</p>
                <Link href="/contacto#mayoreo" className="mt-2 inline-flex text-sm font-medium text-[#e4252c]">
                  Solicitar acceso mayorista
                </Link>
              </div>
            ) : (
              <div className="rounded-lg border border-black/10 bg-white p-4">
                <p className="text-sm text-black/45">Precio disponible</p>
                <p className="mt-1 text-lg font-semibold">Este producto no tiene precio mayorista activo.</p>
                <p className="mt-2 text-sm text-black/55">Se aplicará el precio disponible para este producto.</p>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-black/10 bg-white p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <InfoItem label="Stock" value={product.stock > 0 ? `${product.stock} disponibles` : "Sin stock"} />
              <InfoItem label="Marca producto" value={product.brand || "No especificada"} />
              <InfoItem label="SKU / código" value={product.sku} />
            </div>
            <div className="mt-4 border-t border-black/10 pt-4">
              <p className="text-sm font-semibold">Compatibilidad con vehículo</p>
              <p className="mt-1 text-sm text-black/60">{compatibility}</p>
              {compatibilityNotes ? <p className="mt-2 text-sm text-black/60">{compatibilityNotes}</p> : null}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <button
              onClick={() => addToCart(product.id)}
              disabled={product.stock <= 0}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#080808] px-4 py-3 text-sm font-semibold text-white hover:bg-[#e4252c] disabled:cursor-not-allowed disabled:bg-black/20 disabled:text-black/45"
            >
              <ShoppingCart size={18} />
              {product.stock <= 0 ? "Sin stock" : `Agregar - ${formatCurrency(displayPrice)}`}
            </button>
            {productWhatsappUrl ? (
              <a
                href={productWhatsappUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-4 py-3 text-sm font-semibold hover:border-[#e4252c]/30 hover:bg-[#fff1f2]"
              >
                <FaWhatsapp aria-hidden="true" className="size-[18px]" />
                Consultar por WhatsApp
              </a>
            ) : (
              <button
                type="button"
                disabled
                title="WhatsApp no está configurado por el comercio."
                className="inline-flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-md border border-black/10 bg-black/5 px-4 py-3 text-sm font-semibold text-black/45"
              >
                <FaWhatsapp aria-hidden="true" className="size-[18px]" />
                Consultar por WhatsApp
              </button>
            )}
          </div>
          {cartMessage ? <p className="text-sm font-medium text-[#9b341b]">{cartMessage}</p> : null}

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Pago seguro", "Tarjeta mediante enlace externo enviado por WhatsApp.", ShieldCheck],
              ["Entrega", "Despacho coordinado por pedido.", Truck],
              ["Inventario", "Stock conectado al catálogo.", PackageCheck],
            ].map(([title, text, Icon]) => (
              <div key={title as string} className="rounded-lg border border-black/10 bg-white p-3">
                <Icon size={18} className="mb-2 text-[#e4252c]" />
                <p className="text-sm font-semibold">{title as string}</p>
                <p className="mt-1 text-xs text-black/55">{text as string}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-4 px-4 pb-10 sm:px-5 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-lg border border-black/10 bg-white p-5">
          <p className="text-xs font-semibold uppercase text-[#e4252c]">Descripción completa</p>
          <h2 className="mt-2 text-2xl font-semibold">Información del producto</h2>
          <div className="mt-4 whitespace-pre-line text-sm leading-7 text-black/70">
            {product.description || "Descripción completa pendiente de completar."}
          </div>
        </div>

        <div className="space-y-4">
          <DetailList title="Características" items={featureLines} fallback="Características pendientes de completar." />
          <DetailList title="Especificaciones" items={specificationLines} fallback="Especificaciones pendientes de completar." />
        </div>
      </section>

      {relatedProducts.length > 0 ? (
        <section className="mx-auto max-w-7xl px-4 pb-10 sm:px-5">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-2xl font-semibold">También podría interesarte</h2>
            <Link href="/catalogo" className="text-sm font-medium text-[#e4252c]">
              Ver categoría
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
            {relatedProducts.map((item) => (
              <CatalogProductCard key={item.id} product={item} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase text-black/45">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function DetailList({ title, items, fallback }: { title: string; items: string[]; fallback: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-5">
      <h3 className="text-lg font-semibold">{title}</h3>
      {items.length > 0 ? (
        <ul className="mt-3 space-y-2 text-sm text-black/70">
          {items.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#e4252c]" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-black/55">{fallback}</p>
      )}
    </div>
  );
}

function formatCompatibility(product: Product) {
  const brand = product.vehicle_brand?.trim();
  const model = product.vehicle_model?.trim();
  const start = product.vehicle_year_start;
  const end = product.vehicle_year_end;

  if (!brand && !model && !start && !end) {
    return "Accesorio universal o compatibilidad pendiente de confirmar.";
  }

  const vehicle = [brand, model].filter(Boolean).join(" ");
  const years = start && end ? `${start}-${end}` : start ?? end;
  return [vehicle || "Vehículo compatible", years ? `año ${years}` : null].filter(Boolean).join(" / ");
}
