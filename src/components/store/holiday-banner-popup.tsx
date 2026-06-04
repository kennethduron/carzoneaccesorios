"use client";

import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundMessage, setSoundMessage] = useState("");
  const [brokenMediaIds, setBrokenMediaIds] = useState<Set<string>>(() => new Set());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const currentBanner = activeBanners[index] ?? null;
  const currentBannerId = currentBanner?.id ?? "";
  const currentBannerDurationSeconds = currentBanner?.media_duration_seconds ?? null;
  const mediaUrl = currentBanner?.media_url ?? currentBanner?.image_url ?? null;
  const posterUrl = currentBanner?.media_thumbnail_url || (mediaUrl && currentBanner?.media_type === "image" ? getBannerPosterUrl(mediaUrl) : "");
  const isVideoBanner = Boolean(mediaUrl && currentBanner?.media_type === "video");
  const hasBrokenMedia = Boolean(currentBanner?.id && brokenMediaIds.has(currentBanner.id));
  const storageKey = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const ids = activeBanners.map((item) => item.id).join(":");
    return ids ? `car-zone-banner-closed:${ids}:${today}` : "";
  }, [activeBanners]);
  const resetSoundState = useCallback(() => {
    setSoundEnabled(false);
    setSoundMessage("");
  }, []);
  const advanceBanner = useCallback(() => {
    if (activeBanners.length < 2) {
      return;
    }

    resetSoundState();
    setIndex((current) => (current + 1) % activeBanners.length);
  }, [activeBanners.length, resetSoundState]);

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
    if (videoRef.current) {
      videoRef.current.muted = !soundEnabled;
    }
  }, [currentBannerId, soundEnabled]);

  useEffect(() => {
    if (!visible || activeBanners.length < 2 || !currentBannerId) {
      return;
    }

    if (isVideoBanner) {
      const durationMs = currentBannerDurationSeconds
        ? Math.min(Math.max(currentBannerDurationSeconds * 1000 + 1500, 8000), 65000)
        : 65000;
      const timeout = window.setTimeout(advanceBanner, durationMs);
      return () => window.clearTimeout(timeout);
    }

    const timeout = window.setTimeout(advanceBanner, 6500);
    return () => window.clearTimeout(timeout);
  }, [activeBanners.length, advanceBanner, currentBannerDurationSeconds, currentBannerId, isVideoBanner, visible]);

  if (!currentBanner || !visible) {
    return null;
  }

  function close() {
    window.localStorage.setItem(storageKey, "1");
    resetSoundState();
    setVisible(false);
  }

  function move(delta: number) {
    resetSoundState();
    setIndex((current) => (current + delta + activeBanners.length) % activeBanners.length);
  }

  function showBanner(nextIndex: number) {
    resetSoundState();
    setIndex(nextIndex);
  }

  async function toggleSound() {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (soundEnabled) {
      video.muted = true;
      setSoundEnabled(false);
      setSoundMessage("");
      return;
    }

    try {
      video.muted = false;
      video.volume = 1;
      await video.play();
      setSoundEnabled(true);
      setSoundMessage("");
    } catch {
      video.muted = true;
      setSoundEnabled(false);
      setSoundMessage("El navegador bloqueo el audio. Toca reproducir e intenta nuevamente.");
    }
  }

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

        <div className={`relative ${isVideoBanner ? "bg-[#080808]" : "bg-white"}`}>
          {isVideoBanner && !hasBrokenMedia ? (
            <video
              key={currentBanner.id}
              ref={videoRef}
              src={mediaUrl ?? undefined}
              poster={posterUrl || undefined}
              autoPlay
              muted={!soundEnabled}
              loop={activeBanners.length < 2}
              playsInline
              preload="metadata"
              onEnded={advanceBanner}
              onError={() => {
                setBrokenMediaIds((current) => new Set(current).add(currentBanner.id));
                advanceBanner();
              }}
              className="max-h-[58vh] min-h-[220px] w-full object-cover"
            >
              Tu navegador no puede reproducir este video.
            </video>
          ) : mediaUrl && !hasBrokenMedia ? (
            <Image
              src={getBannerImageUrl(mediaUrl)}
              alt={currentBanner.title}
              width={1400}
              height={760}
              priority={index === 0}
              className="max-h-[58vh] min-h-[220px] w-full object-cover"
              unoptimized={mediaUrl.includes("res.cloudinary.com")}
              onError={() => setBrokenMediaIds((current) => new Set(current).add(currentBanner.id))}
            />
          ) : (
            <div className="grid min-h-[220px] place-items-center bg-zinc-100 px-6 py-12 text-center text-sm text-black/60">
              No se pudo cargar la imagen de este banner.
            </div>
          )}

          {isVideoBanner ? (
            <div className="absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-1">
              <button
                type="button"
                onClick={toggleSound}
                className="inline-flex min-h-9 items-center gap-2 rounded-md bg-white/92 px-3 text-xs font-semibold text-[#080808] shadow transition hover:bg-white"
                aria-label={soundEnabled ? "Silenciar video" : "Activar sonido del video"}
              >
                {soundEnabled ? <VolumeX size={16} /> : <Volume2 size={16} />}
                {soundEnabled ? "Silenciar" : "Activar sonido"}
              </button>
              {soundMessage ? <p className="rounded-md bg-black/72 px-2 py-1 text-xs text-white">{soundMessage}</p> : null}
            </div>
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
                  onClick={() => showBanner(itemIndex)}
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
