"use client";

import Image from "next/image";
import Link from "next/link";
import { Eye, ImageOff, Plus } from "lucide-react";
import { useState } from "react";
import type { Product } from "@/types/commerce";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";
import { getProductThumbnailUrl, isCloudinaryImageUrl } from "@/utils/image-optimization";
import { formatCurrency, getProductPrice } from "@/utils/pricing";
import { getProductCardDescription } from "@/utils/product-content";

export function CatalogProductCard({ product }: { product: Product }) {
  const { priceMode } = usePriceMode();
  const { addToCart, cartMessage } = useShoppingCart();
  const primaryImage = product.images.find((image) => image.angle === "frontal") ?? product.images[0];
  const imageUrl = getProductThumbnailUrl(primaryImage?.url ?? product.image);
  const [imageFailed, setImageFailed] = useState(false);
  const hasWholesalePrice = product.wholesale_price > 0 && product.wholesale_price < product.retail_price;
  const isLowStock = product.stock > 0 && product.stock <= 3;
  const cardDescription = getProductCardDescription(product);

  return (
    <article className="flex h-full flex-col overflow-hidden rounded-lg border border-black/10 bg-white shadow-sm transition-all duration-200 hover:-translate-y-1 hover:border-[#e4252c]/25 hover:shadow-lg">
      <Link href={`/producto/${product.slug}`} className="block">
        <div className="relative">
          <div className="absolute left-2 top-2 z-10 flex flex-wrap gap-1">
            {product.stock <= 0 ? (
              <span className="rounded-md bg-black/80 px-2 py-1 text-[10px] font-semibold uppercase text-white">Agotado</span>
            ) : isLowStock ? (
              <span className="rounded-md bg-[#fff1f2] px-2 py-1 text-[10px] font-semibold uppercase text-[#b91c25]">Ultimos</span>
            ) : (
              <span className="rounded-md bg-white/90 px-2 py-1 text-[10px] font-semibold uppercase text-[#080808]">Nuevo</span>
            )}
            {hasWholesalePrice ? (
              <span className="rounded-md bg-[#e4252c] px-2 py-1 text-[10px] font-semibold uppercase text-white">Mayoreo</span>
            ) : null}
          </div>
          {imageFailed ? (
            <div className="grid aspect-[4/3] w-full place-items-center bg-[#e7e5e4] text-[#78716c]">
              <div className="flex flex-col items-center gap-2 text-sm">
                <ImageOff size={24} />
                Imagen no disponible
              </div>
            </div>
          ) : (
            <Image
              src={imageUrl}
              alt={primaryImage?.alt ?? product.name}
              width={400}
              height={276}
              sizes="(min-width: 1280px) 390px, (min-width: 768px) 50vw, 100vw"
              loading="lazy"
              quality={70}
              unoptimized={isCloudinaryImageUrl(imageUrl)}
              className="aspect-[4/3] w-full object-cover transition-transform duration-300 hover:scale-[1.02]"
              onError={() => setImageFailed(true)}
            />
          )}
        </div>
        <div className="space-y-2 p-3 sm:space-y-3 sm:p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs uppercase text-black/45">{product.sku}</p>
              <h2 className="mt-1 line-clamp-2 text-sm font-semibold leading-tight sm:text-lg">{product.name}</h2>
            </div>
            <span className="max-w-24 shrink-0 truncate rounded-md bg-[#e7e5e4] px-2 py-1 text-[11px] text-black/65 sm:max-w-28 sm:text-xs">{product.category}</span>
          </div>
          {cardDescription ? <p className="line-clamp-2 min-h-[2.5rem] text-sm leading-5 text-black/60">{cardDescription}</p> : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs text-black/45">precio al detalle</p>
              <p className="text-lg font-semibold sm:text-2xl">{formatCurrency(product.retail_price)}</p>
              {priceMode === "wholesale" && hasWholesalePrice ? (
                <p className="text-xs font-semibold text-[#b91c25]">Mayoreo {formatCurrency(getProductPrice(product, priceMode))}</p>
              ) : null}
            </div>
            <p className="text-xs font-medium text-black/50">
              {product.stock <= 0 ? "Sin stock" : isLowStock ? `Quedan ${product.stock}` : "Disponible"}
            </p>
          </div>
        </div>
      </Link>
      <div className="mt-auto grid gap-2 border-t border-black/10 p-3 sm:grid-cols-2 sm:p-4">
        <Link
          href={`/producto/${product.slug}`}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/10 px-2 text-xs font-semibold transition-all hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:bg-[#fff1f2] sm:text-sm"
        >
          <Eye size={16} />
          Detalle
        </Link>
        <button
          onClick={() => addToCart(product.id)}
          disabled={product.stock <= 0}
          className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-[#080808] px-2 text-xs font-semibold text-white transition-all hover:-translate-y-0.5 hover:bg-[#e4252c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-black/20 disabled:text-black/45 disabled:hover:translate-y-0 sm:text-sm"
        >
          <Plus size={16} />
          {product.stock <= 0 ? "Sin stock" : "Agregar"}
        </button>
        {cartMessage ? <p className="col-span-full mt-1 text-sm font-medium text-[#9b341b]">{cartMessage}</p> : null}
      </div>
    </article>
  );
}


