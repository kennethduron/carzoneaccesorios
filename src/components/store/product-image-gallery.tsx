"use client";

import Image from "next/image";
import { ChevronLeft, ChevronRight, ImageOff, Maximize2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Product } from "@/types/commerce";
import {
  getProductGalleryThumbnailUrl,
  getProductImageUrl,
  getProductZoomUrl,
  isCloudinaryImageUrl,
} from "@/utils/image-optimization";

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
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});
  const activeImage = images[activeIndex];
  const activeImageFailed = Boolean(failedImages[activeImage.id]);
  const activeImageUrl = getProductImageUrl(activeImage.url);
  const zoomImageUrl = getProductZoomUrl(activeImage.url);

  function previousImage() {
    setActiveIndex((current) => (current === 0 ? images.length - 1 : current - 1));
  }

  function nextImage() {
    setActiveIndex((current) => (current === images.length - 1 ? 0 : current + 1));
  }

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-lg border border-black/10 bg-white">
        {activeImageFailed ? (
          <div className="grid h-[360px] w-full place-items-center bg-[#f0ede2] text-[#6b675d] md:h-[560px]">
            <div className="flex flex-col items-center gap-2 text-sm">
              <ImageOff size={30} />
              Imagen no disponible
            </div>
          </div>
        ) : (
          <Image
            src={activeImageUrl}
            alt={activeImage.alt}
            width={900}
            height={675}
            priority
            sizes="(min-width: 1024px) 58vw, 100vw"
            quality={78}
            unoptimized={isCloudinaryImageUrl(activeImageUrl)}
            className="h-[360px] w-full object-cover md:h-[560px]"
            onError={() => setFailedImages((current) => ({ ...current, [activeImage.id]: true }))}
          />
        )}
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
            {failedImages[image.id] ? (
              <div className="grid h-16 w-full place-items-center bg-[#f0ede2] text-[#6b675d]">
                <ImageOff size={16} />
              </div>
            ) : (
              <Image
                src={getProductGalleryThumbnailUrl(image.url)}
                alt={image.alt}
                width={180}
                height={128}
                sizes="20vw"
                loading="lazy"
                quality={55}
                unoptimized={isCloudinaryImageUrl(image.url)}
                className="h-16 w-full object-cover"
                onError={() => setFailedImages((current) => ({ ...current, [image.id]: true }))}
              />
            )}
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
            {failedImages[`${activeImage.id}-zoom`] ? (
              <div className="grid min-h-[60vh] w-full place-items-center rounded-lg bg-[#f0ede2] text-[#6b675d]">
                <div className="flex flex-col items-center gap-2 text-sm">
                  <ImageOff size={30} />
                  Imagen no disponible
                </div>
              </div>
            ) : (
              <Image
                src={zoomImageUrl}
                alt={activeImage.alt}
                width={1400}
                height={1050}
                sizes="100vw"
                loading="lazy"
                quality={86}
                unoptimized={isCloudinaryImageUrl(zoomImageUrl)}
                className="max-h-[86vh] w-full rounded-lg object-contain"
                onError={() => setFailedImages((current) => ({ ...current, [`${activeImage.id}-zoom`]: true }))}
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
