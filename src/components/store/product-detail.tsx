"use client";

import { useEffect } from "react";
import Link from "next/link";
import { MessageCircle, PackageCheck, ShieldCheck, ShoppingCart, Truck } from "lucide-react";
import type { Product } from "@/types/commerce";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";
import { useProductRegistry } from "@/contexts/product-registry-context";
import { formatCurrency, getProductPrice } from "@/utils/pricing";
import { ProductImageGallery } from "@/components/store/product-image-gallery";
import { CatalogProductCard } from "@/components/store/catalog-product-card";

export function ProductDetail({ product, relatedProducts = [] }: { product: Product; relatedProducts?: Product[] }) {
  const { priceMode } = usePriceMode();
  const { addToCart, cartMessage } = useShoppingCart();
  const { registerProducts } = useProductRegistry();
  const compatibility = formatCompatibility(product);
  const whatsappText = encodeURIComponent(`Hola, quiero informacion sobre ${product.name} (${product.sku}).`);

  useEffect(() => {
    registerProducts([product, ...relatedProducts]);
  }, [product, relatedProducts, registerProducts]);

  return (
    <>
      <section className="mx-auto grid max-w-7xl gap-8 px-4 py-6 sm:px-5 lg:grid-cols-[0.95fr_1.05fr]">
        <ProductImageGallery product={product} />
        <div className="space-y-5">
          <Link href="/catalogo" className="text-sm font-medium text-[#e4252c]">
            Volver al catalogo
          </Link>
          <div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-md bg-[#f4f4f5] px-2 py-1 text-xs font-semibold uppercase text-black/55">{product.sku}</span>
              <span className="rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-semibold uppercase text-[#b91c25]">{product.category}</span>
              {product.wholesale_price > 0 && product.wholesale_price < product.retail_price ? (
                <span className="rounded-md bg-[#080808] px-2 py-1 text-xs font-semibold uppercase text-white">Mayoreo</span>
              ) : null}
            </div>
            <h1 className="mt-3 text-3xl font-semibold leading-tight md:text-5xl">{product.name}</h1>
            <p className="mt-4 text-black/65">{product.description}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-black/10 bg-white p-4">
              <p className="text-sm text-black/45">Precio al detalle</p>
              <p className="mt-1 text-3xl font-semibold">{formatCurrency(product.retail_price)}</p>
              <p className="mt-1 text-sm text-black/55">Precio publico del catalogo</p>
            </div>
            <div className="rounded-lg border border-black/10 bg-white p-4">
              <p className="text-sm text-black/45">Precio mayorista</p>
              <p className="mt-1 text-3xl font-semibold">{formatCurrency(product.wholesale_price)}</p>
              <p className="mt-1 text-sm text-black/55">
                {priceMode === "wholesale" ? "Aplicado ahora" : "Disponible con codigo mayorista"}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-black/10 bg-white p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <InfoItem label="Stock" value={product.stock > 0 ? `${product.stock} disponibles` : "Sin stock"} />
              <InfoItem label="Marca producto" value={product.brand || "No especificada"} />
              <InfoItem label="SKU / codigo" value={product.sku} />
            </div>
            <div className="mt-4 border-t border-black/10 pt-4">
              <p className="text-sm font-semibold">Compatibilidad con vehiculo</p>
              <p className="mt-1 text-sm text-black/60">{compatibility}</p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <button
              onClick={() => addToCart(product.id)}
              disabled={product.stock <= 0}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#080808] px-4 py-3 text-sm font-semibold text-white hover:bg-[#e4252c] disabled:cursor-not-allowed disabled:bg-black/20 disabled:text-black/45"
            >
              <ShoppingCart size={18} />
              {product.stock <= 0 ? "Sin stock" : `Agregar - ${formatCurrency(getProductPrice(product, priceMode))}`}
            </button>
            <Link
              href={`https://wa.me/?text=${whatsappText}`}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-4 py-3 text-sm font-semibold hover:border-[#e4252c]/30 hover:bg-[#fff1f2]"
            >
              <MessageCircle size={18} />
              Consultar por WhatsApp
            </Link>
          </div>
          {cartMessage ? <p className="text-sm font-medium text-[#9b341b]">{cartMessage}</p> : null}

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Pago seguro", "No guardamos datos de tarjeta.", ShieldCheck],
              ["Entrega", "Despacho coordinado por pedido.", Truck],
              ["Inventario", "Stock conectado al catalogo.", PackageCheck],
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

      {relatedProducts.length > 0 ? (
        <section className="mx-auto max-w-7xl px-4 pb-10 sm:px-5">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-2xl font-semibold">Productos relacionados</h2>
            <Link href="/catalogo" className="text-sm font-medium text-[#e4252c]">
              Ver categoria
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
  return [vehicle || "Vehiculo compatible", years ? `anio ${years}` : null].filter(Boolean).join(" / ");
}
