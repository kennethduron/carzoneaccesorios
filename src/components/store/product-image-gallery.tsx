"use client";

import Image from "next/image";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Product } from "@/types/commerce";

export function ProductImageGallery({ product }: { product: Product }) {
  const images = useMemo(
    () =>
      product.images.length > 0
        ? product.images
        : [
            {
              id: `${product.id}-frontal`,
              angle: "frontal" as const,
              label: "Frontal",
              url: product.image,
              alt: product.name,
            },
          ],
    [product],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [zoomOpen, setZoomOpen] = useState(false);
  const activeImage = images[activeIndex];

  function previousImage() {
    setActiveIndex((current) => (current === 0 ? images.length - 1 : current - 1));
  }

  function nextImage() {
    setActiveIndex((current) => (current === images.length - 1 ? 0 : current + 1));
  }

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-lg border border-black/10 bg-white">
        <Image
          src={activeImage.url}
          alt={activeImage.alt}
          width={1200}
          height={820}
          priority
          className="h-[360px] w-full object-cover md:h-[560px]"
        />
        <div className="absolute left-3 top-3 rounded-md bg-white/90 px-3 py-2 text-sm font-medium">
          {activeImage.label}
        </div>
        <div className="absolute bottom-3 right-3 flex gap-2">
          <button
            onClick={previousImage}
            className="grid size-10 place-items-center rounded-md bg-white/90 text-[#1c1d1b]"
            aria-label="Imagen anterior"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            onClick={nextImage}
            className="grid size-10 place-items-center rounded-md bg-white/90 text-[#1c1d1b]"
            aria-label="Imagen siguiente"
          >
            <ChevronRight size={18} />
          </button>
          <button
            onClick={() => setZoomOpen(true)}
            className="grid size-10 place-items-center rounded-md bg-white/90 text-[#1c1d1b]"
            aria-label="Abrir zoom"
          >
            <Maximize2 size={18} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {images.map((image, index) => (
          <button
            key={image.id}
            onClick={() => setActiveIndex(index)}
            className={`overflow-hidden rounded-md border bg-white text-left ${
              activeIndex === index ? "border-[#246a73]" : "border-black/10"
            }`}
            aria-label={`Ver imagen ${image.label}`}
          >
            <Image src={image.url} alt={image.alt} width={220} height={150} className="h-16 w-full object-cover" />
            <span className="block truncate px-2 py-1 text-xs text-black/60">{image.label}</span>
          </button>
        ))}
      </div>

      {zoomOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4">
          <div className="relative w-full max-w-6xl">
            <button
              onClick={() => setZoomOpen(false)}
              className="absolute right-3 top-3 z-10 grid size-10 place-items-center rounded-md bg-white text-[#1c1d1b]"
              aria-label="Cerrar zoom"
            >
              <X size={18} />
            </button>
            <Image
              src={activeImage.url}
              alt={activeImage.alt}
              width={1600}
              height={1100}
              className="max-h-[86vh] w-full rounded-lg object-contain"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
