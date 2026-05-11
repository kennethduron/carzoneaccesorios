"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ShoppingCart } from "lucide-react";
import type { Product } from "@/types/commerce";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";
import { useProductRegistry } from "@/contexts/product-registry-context";
import { formatCurrency, getProductPrice } from "@/utils/pricing";
import { ProductImageGallery } from "@/components/store/product-image-gallery";

export function ProductDetail({ product }: { product: Product }) {
  const { priceMode } = usePriceMode();
  const { addToCart, cartMessage } = useShoppingCart();
  const { registerProducts } = useProductRegistry();

  useEffect(() => {
    registerProducts([product]);
  }, [product, registerProducts]);

  return (
    <section className="mx-auto grid max-w-7xl gap-8 px-5 py-8 lg:grid-cols-[0.95fr_1.05fr]">
      <ProductImageGallery product={product} />
      <div className="space-y-5">
        <Link href="/catalogo" className="text-sm font-medium text-[#246a73]">
          Volver al catálogo
        </Link>
        <div>
          <p className="text-sm uppercase text-black/45">{product.sku} / {product.brand}</p>
          <h1 className="mt-2 text-4xl font-semibold">{product.name}</h1>
          <p className="mt-4 text-black/65">{product.description}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-black/10 bg-white p-4">
            <p className="text-sm text-black/45">Precio aplicado</p>
            <p className="mt-1 text-3xl font-semibold">{formatCurrency(getProductPrice(product, priceMode))}</p>
            <p className="mt-1 text-sm text-black/55">
              Fuente: {priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}
            </p>
          </div>
          <div className="rounded-lg border border-black/10 bg-white p-4">
            <p className="text-sm text-black/45">Disponibilidad</p>
            <p className="mt-1 text-3xl font-semibold">{product.stock}</p>
            <p className="mt-1 text-sm text-black/55">Unidades en inventario</p>
          </div>
        </div>
        <button
          onClick={() => addToCart(product.id)}
          disabled={product.stock <= 0}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#1c1d1b] px-4 py-3 text-sm font-medium text-white sm:w-auto"
        >
          <ShoppingCart size={18} />
          {product.stock <= 0 ? "Sin stock" : "Agregar al carrito"}
        </button>
        {cartMessage ? <p className="text-sm font-medium text-[#9b341b]">{cartMessage}</p> : null}
      </div>
    </section>
  );
}
