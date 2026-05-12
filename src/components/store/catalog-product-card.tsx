"use client";

import Image from "next/image";
import Link from "next/link";
import { ImageOff, Plus } from "lucide-react";
import { useState } from "react";
import type { Product } from "@/types/commerce";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";
import { getProductThumbnailUrl, isCloudinaryImageUrl } from "@/utils/image-optimization";
import { formatCurrency, getProductPrice } from "@/utils/pricing";

export function CatalogProductCard({ product }: { product: Product }) {
  const { priceMode } = usePriceMode();
  const { addToCart, cartMessage } = useShoppingCart();
  const primaryImage = product.images.find((image) => image.angle === "frontal") ?? product.images[0];
  const imageUrl = getProductThumbnailUrl(primaryImage?.url ?? product.image);
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <article className="overflow-hidden rounded-lg border border-black/10 bg-white">
      <Link href={`/producto/${product.slug}`} className="block">
        {imageFailed ? (
          <div className="grid h-44 w-full place-items-center bg-[#f0ede2] text-[#6b675d]">
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
            className="h-44 w-full object-cover"
            onError={() => setImageFailed(true)}
          />
        )}
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
                {priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}
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
