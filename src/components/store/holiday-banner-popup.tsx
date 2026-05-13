"use client";

import Image from "next/image";
import Link from "next/link";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { HolidayBanner } from "@/types/settings";

export function HolidayBannerPopup({ banner }: { banner: HolidayBanner | null }) {
  const [visible, setVisible] = useState(false);
  const storageKey = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return banner ? `car-zone-banner-closed:${banner.id}:${today}` : "";
  }, [banner]);

  useEffect(() => {
    if (!banner || !storageKey) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setVisible(window.localStorage.getItem(storageKey) !== "1");
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [banner, storageKey]);

  if (!banner || !visible) {
    return null;
  }

  function close() {
    window.localStorage.setItem(storageKey, "1");
    setVisible(false);
  }

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/45 px-4 py-6">
      <section className="relative w-full max-w-2xl overflow-hidden rounded-lg bg-white shadow-xl">
        <button
          type="button"
          onClick={close}
          className="absolute right-3 top-3 z-10 grid size-9 place-items-center rounded-md bg-white/90 text-[#1c1d1b] shadow"
          aria-label="Cerrar banner"
        >
          <X size={18} />
        </button>
        {banner.image_url ? (
          <Image src={banner.image_url} alt={banner.title} width={1200} height={620} className="max-h-[58vh] w-full object-cover" />
        ) : null}
        <div className="p-5">
          <h2 className="text-2xl font-semibold">{banner.title}</h2>
          <p className="mt-2 text-sm text-black/60">{banner.message}</p>
          {banner.button_text && banner.button_url ? (
            <Link
              href={banner.button_url}
              onClick={close}
              className="mt-4 inline-flex rounded-md bg-[#246a73] px-4 py-2 text-sm font-semibold text-white"
            >
              {banner.button_text}
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  );
}
