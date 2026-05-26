"use client";

import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { HolidayBanner } from "@/types/settings";
import { getBannerImageUrl, getBannerPosterUrl } from "@/utils/image-optimization";

type HolidayBannerPopupProps = {
  banners?: HolidayBanner[];
  banner?: HolidayBanner | null;
};

export function HolidayBannerPopup({ banners, banner }: HolidayBannerPopupProps) {
  const activeBanners = useMemo(() => (banners && banners.length > 0 ? banners : banner ? [banner] : []), [banner, banners]);
  const [visible, setVisible] = useState(false);
  const [index, setIndex] = useState(0);
  const currentBanner = activeBanners[index] ?? null;
  const storageKey = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const ids = activeBanners.map((item) => item.id).join(":");
    return ids ? `car-zone-banner-closed:${ids}:${today}` : "";
  }, [activeBanners]);

  useEffect(() => {
    if (!storageKey || activeBanners.length === 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setVisible(window.localStorage.getItem(storageKey) !== "1");
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [activeBanners.length, storageKey]);

  useEffect(() => {
    if (!visible || activeBanners.length < 2) {
      return;
    }

    const interval = window.setInterval(() => {
      setIndex((current) => (current + 1) % activeBanners.length);
    }, 6500);

    return () => window.clearInterval(interval);
  }, [activeBanners.length, visible]);

  if (!currentBanner || !visible) {
    return null;
  }

  function close() {
    window.localStorage.setItem(storageKey, "1");
    setVisible(false);
  }

  function move(delta: number) {
    setIndex((current) => (current + delta + activeBanners.length) % activeBanners.length);
  }

  const mediaUrl = currentBanner.media_url ?? currentBanner.image_url;
  const posterUrl = currentBanner.media_thumbnail_url || (mediaUrl && currentBanner.media_type === "image" ? getBannerPosterUrl(mediaUrl) : "");

  return (
    <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/45 px-4 py-6">
      <section className="relative w-full max-w-3xl overflow-hidden rounded-lg bg-white shadow-xl">
        <button
          type="button"
          onClick={close}
          className="absolute right-3 top-3 z-10 grid size-9 place-items-center rounded-md bg-white/90 text-[#080808] shadow"
          aria-label="Cerrar banner"
        >
          <X size={18} />
        </button>

        <div className="relative bg-[#080808]">
          {mediaUrl && currentBanner.media_type === "video" ? (
            <video
              key={currentBanner.id}
              src={mediaUrl}
              poster={posterUrl || undefined}
              autoPlay
              muted
              loop
              playsInline
              preload={index === 0 ? "auto" : "metadata"}
              className="max-h-[58vh] min-h-[220px] w-full object-cover"
            />
          ) : mediaUrl ? (
            <Image
              src={getBannerImageUrl(mediaUrl)}
              alt={currentBanner.title}
              width={1400}
              height={760}
              priority={index === 0}
              className="max-h-[58vh] min-h-[220px] w-full object-cover"
              unoptimized={mediaUrl.includes("res.cloudinary.com")}
            />
          ) : null}

          {activeBanners.length > 1 ? (
            <>
              <button
                type="button"
                onClick={() => move(-1)}
                className="absolute left-3 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-md bg-white/88 text-[#080808] shadow"
                aria-label="Banner anterior"
              >
                <ChevronLeft size={19} />
              </button>
              <button
                type="button"
                onClick={() => move(1)}
                className="absolute right-3 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-md bg-white/88 text-[#080808] shadow"
                aria-label="Banner siguiente"
              >
                <ChevronRight size={19} />
              </button>
            </>
          ) : null}
        </div>

        <div className="p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold">{currentBanner.title}</h2>
              <p className="mt-2 text-sm text-black/60">{currentBanner.message}</p>
            </div>
            {currentBanner.button_text && currentBanner.button_url ? (
              <Link
                href={currentBanner.button_url}
                onClick={close}
                className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-md bg-[#e4252c] px-4 text-sm font-semibold text-white"
              >
                {currentBanner.button_text}
              </Link>
            ) : null}
          </div>

          {activeBanners.length > 1 ? (
            <div className="mt-4 flex gap-1.5">
              {activeBanners.map((item, itemIndex) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setIndex(itemIndex)}
                  className={`h-2 rounded-full transition-all ${itemIndex === index ? "w-7 bg-[#e4252c]" : "w-2 bg-black/20"}`}
                  aria-label={`Mostrar banner ${itemIndex + 1}`}
                />
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
