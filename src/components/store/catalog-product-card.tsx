"use client";

import Image from "next/image";
import Link from "next/link";
import { Plus } from "lucide-react";
import type { Product } from "@/types/commerce";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";
import { formatCurrency, getProductPrice } from "@/utils/pricing";

export function CatalogProductCard({ product }: { product: Product }) {
  const { priceMode } = usePriceMode();
  const { addToCart, cartMessage } = useShoppingCart();
  const primaryImage = product.images.find((image) => image.angle === "frontal") ?? product.images[0];

  return (
    <article className="overflow-hidden rounded-lg border border-black/10 bg-white">
      <Link href={`/producto/${product.slug}`} className="block">
        <Image
          src={primaryImage?.url ?? product.image}
          alt={primaryImage?.alt ?? product.name}
          width={900}
          height={520}
          className="h-44 w-full object-cover"
        />
        <div className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase text-black/45">{product.sku}</p>
              <h2 className="mt-1 text-lg font-semibold">{product.name}</h2>
            </div>
            <span className="rounded-md bg-[#f0ede2] px-2 py-1 text-xs">{product.category}</span>
          </div>
          <p className="line-clamp-2 text-sm text-black/60">{product.description}</p>
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs text-black/45">
                {priceMode === "wholesale" ? "wholesale_price" : "retail_price"}
              </p>
              <p className="text-2xl font-semibold">{formatCurrency(getProductPrice(product, priceMode))}</p>
            </div>
            <p className="text-sm text-black/50">Stock {product.stock}</p>
          </div>
        </div>
      </Link>
      <div className="border-t border-black/10 p-4">
        <button
          onClick={() => addToCart(product.id)}
          disabled={product.stock <= 0}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#1c1d1b] px-4 py-3 text-sm font-medium text-white"
        >
          <Plus size={18} />
          {product.stock <= 0 ? "Sin stock" : "Agregar"}
        </button>
        {cartMessage ? <p className="mt-2 text-sm font-medium text-[#9b341b]">{cartMessage}</p> : null}
      </div>
    </article>
  );
}
