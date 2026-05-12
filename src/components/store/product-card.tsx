"use client";

import Image from "next/image";
import { ImageOff, Plus } from "lucide-react";
import { useState } from "react";
import type { PriceMode, Product } from "@/types/commerce";
import { getProductThumbnailUrl, isCloudinaryImageUrl } from "@/utils/image-optimization";
import { formatCurrency, getProductPrice } from "@/utils/pricing";
import { Button } from "@/components/ui/button";

type ProductCardProps = {
  product: Product;
  priceMode: PriceMode;
  onAdd: (productId: string) => void;
  onOpen: (product: Product) => void;
};

export function ProductCard({ product, priceMode, onAdd, onOpen }: ProductCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = getProductThumbnailUrl(product.image);

  return (
    <article className="overflow-hidden rounded-lg border border-black/10 bg-white">
      <button onClick={() => onOpen(product)} className="block w-full text-left">
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
            alt={product.name}
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
              <p className="text-2xl font-semibold">
                {formatCurrency(getProductPrice(product, priceMode))}
              </p>
            </div>
            <p className="text-sm text-black/50">Stock {product.stock}</p>
          </div>
        </div>
      </button>
      <div className="border-t border-black/10 p-4">
        <Button onClick={() => onAdd(product.id)} variant="dark" className="w-full py-3">
          <Plus size={18} />
          Agregar
        </Button>
      </div>
    </article>
  );
}
