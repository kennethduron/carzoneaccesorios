"use client";

import Image from "next/image";
import Link from "next/link";
import { ChevronDown, LogIn, LogOut, Menu, ShoppingCart, UserRound, X } from "lucide-react";
import { FaFacebookF, FaInstagram, FaTiktok, FaWhatsapp, FaYoutube } from "react-icons/fa";
import { FiGlobe } from "react-icons/fi";
import { useEffect, useRef, useState } from "react";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { getPublicCompanySettingsClient } from "@/services/supabase/company-settings-client.service";
import type { SocialSettings } from "@/types/settings";

const primaryLinks = [
  ["Inicio", "/"],
  ["Catálogo", "/catalogo"],
  ["Contacto", "/contacto"],
  ["Rastrear pedido", "/rastreo"],
];

const userMenuLinks = [
  ["Mi cuenta", "/cuenta"],
  ["Mis pedidos", "/mis-pedidos"],
  ["Facturas", "/facturas"],
  ["Solicitar mayoreo", "/contacto#mayoreo"],
];

export function PublicStoreShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [cartPulse, setCartPulse] = useState(false);
  const [socialSettings, setSocialSettings] = useState<SocialSettings | null>(null);
  const previousCartCount = useRef(0);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const { priceMode } = usePriceMode();
  const { cartCount } = useShoppingCart();

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setIsAuthenticated(Boolean(data.session));
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsAuthenticated(Boolean(session));
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;

    getPublicCompanySettingsClient().then((settings) => {
      if (active) {
        setSocialSettings(settings);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (cartCount > previousCartCount.current) {
      setCartPulse(true);
      const timeout = window.setTimeout(() => setCartPulse(false), 650);
      previousCartCount.current = cartCount;
      return () => window.clearTimeout(timeout);
    }

    previousCartCount.current = cartCount;
    return undefined;
  }, [cartCount]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!userMenuRef.current?.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#f4f4f5] text-[#080808]">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-black/10 bg-white/95 shadow-sm backdrop-blur">
        <div className="relative mx-auto flex h-16 max-w-7xl items-center justify-between gap-1.5 px-4 sm:h-[70px] sm:gap-4 sm:px-5">
          <Link
            href="/"
            className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3"
            aria-label="Ir al inicio de Car Zone Accesorios"
          >
            <span className="relative h-12 w-[118px] shrink-0 sm:h-[50px] sm:w-[150px]">
              <Image
                src="/brand/car-zone-logo-nav.png"
                alt="Car Zone Accesorios"
                fill
                preload
                sizes="(max-width: 640px) 118px, 150px"
                className="object-contain object-left"
              />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-base font-semibold sm:text-lg">Car Zone Accesorios</span>
              <span className="block truncate text-[11px] text-black/55 sm:text-xs">Accesorios automotrices</span>
            </span>
          </Link>

          <nav className="hidden items-center gap-1 lg:flex">
            {primaryLinks.map(([label, href]) => (
              <Link key={href} href={href} className="rounded-md px-3 py-2 text-sm hover:bg-white">
                {label}
              </Link>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {priceMode === "wholesale" ? (
              <span className="hidden rounded-md border border-[#e4252c]/25 bg-[#fff1f2] px-3 py-2 text-sm font-semibold text-[#b91c25] sm:inline-flex">
                Mayoreo activo
              </span>
            ) : null}

            <div ref={userMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setUserMenuOpen((current) => !current)}
                className="inline-flex h-10 items-center justify-center gap-1 rounded-md border border-black/10 bg-white px-2.5 text-sm hover:bg-white/80 sm:px-3"
                aria-label="Abrir menú de usuario"
                aria-expanded={userMenuOpen}
              >
                <UserRound size={17} />
                <ChevronDown size={14} className={`transition-transform ${userMenuOpen ? "rotate-180" : ""}`} />
              </button>

              {userMenuOpen ? (
                <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-md border border-black/10 bg-white py-2 shadow-xl">
                  {userMenuLinks.map(([label, href]) => (
                    <Link
                      key={href}
                      href={href}
                      className="block px-4 py-2 text-sm hover:bg-[#f4f4f5]"
                      onClick={() => setUserMenuOpen(false)}
                    >
                      {label}
                    </Link>
                  ))}

                  <div className="mt-2 border-t border-black/10 pt-2">
                    {isAuthenticated ? (
                      <form action="/auth/logout" method="post">
                        <button type="submit" className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-[#f4f4f5]">
                          <LogOut size={16} />
                          Cerrar sesión
                        </button>
                      </form>
                    ) : (
                      <Link
                        href="/login"
                        className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-[#f4f4f5]"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        <LogIn size={16} />
                        Iniciar sesión
                      </Link>
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            <Link
              href="/carrito"
              className={`inline-flex h-10 shrink-0 items-center justify-center gap-1 rounded-md bg-[#080808] px-3 text-sm font-semibold text-white transition-transform hover:bg-[#e4252c] sm:gap-2 ${
                cartPulse ? "scale-110 ring-4 ring-[#e4252c]/20" : ""
              }`}
            >
              <ShoppingCart size={16} />
              <span>{cartCount}</span>
            </Link>
            <button
              onClick={() => setOpen((current) => !current)}
              className="grid size-10 place-items-center rounded-md border border-black/10 bg-white lg:hidden"
              aria-label="Abrir menú"
            >
              {open ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>

        {open ? (
          <nav className="border-t border-black/10 bg-white px-5 py-3 lg:hidden">
            <div className="mx-auto grid max-w-7xl gap-1">
              {primaryLinks.map(([label, href]) => (
                <Link key={href} href={href} className="rounded-md px-3 py-2 text-sm" onClick={() => setOpen(false)}>
                  {label}
                </Link>
              ))}
              {userMenuLinks.map(([label, href]) => (
                <Link key={href} href={href} className="rounded-md px-3 py-2 text-sm" onClick={() => setOpen(false)}>
                  {label}
                </Link>
              ))}
              {priceMode === "wholesale" ? (
                <span className="rounded-md px-3 py-2 text-sm font-medium text-[#e4252c]">Mayoreo activo</span>
              ) : null}
              {isAuthenticated ? (
                <form action="/auth/logout" method="post">
                  <button type="submit" className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm">
                    <LogOut size={16} />
                    Cerrar sesión
                  </button>
                </form>
              ) : (
                <Link href="/login" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm" onClick={() => setOpen(false)}>
                  <LogIn size={16} />
                  Iniciar sesión
                </Link>
              )}
            </div>
          </nav>
        ) : null}
      </header>
      <div className="h-16 sm:h-[70px]" aria-hidden="true" />
      {children}
      <footer className="border-t border-black/10 bg-white">
        <div className="mx-auto grid max-w-7xl gap-6 px-5 py-8 md:grid-cols-[1fr_auto]">
          <div>
            <p className="font-semibold">Car Zone Accesorios</p>
            <p className="mt-2 max-w-xl text-sm text-black/55">
              Tienda profesional de accesorios automotrices con precios al detalle y mayoristas reales.
            </p>
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold">Síguenos</p>
            <div className="mb-3 flex flex-wrap gap-2">
              <SocialLink href={socialSettings?.facebook_url} label="Facebook">
                <FaFacebookF />
              </SocialLink>
              <SocialLink href={socialSettings?.instagram_url} label="Instagram">
                <FaInstagram />
              </SocialLink>
              <SocialLink href={socialSettings?.whatsapp_url} label="WhatsApp">
                <FaWhatsapp />
              </SocialLink>
              <SocialLink href={socialSettings?.tiktok_url} label="TikTok">
                <FaTiktok />
              </SocialLink>
              <SocialLink href={socialSettings?.youtube_url} label="YouTube">
                <FaYoutube />
              </SocialLink>
              <SocialLink href={socialSettings?.website_url} label="Sitio web">
                <FiGlobe />
              </SocialLink>
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
            <Link href="/mision" className="rounded-md px-3 py-2 hover:bg-[#f4f4f5]">
              Misión
            </Link>
            <Link href="/vision" className="rounded-md px-3 py-2 hover:bg-[#f4f4f5]">
              Visión
            </Link>
            <Link href="/historia" className="rounded-md px-3 py-2 hover:bg-[#f4f4f5]">
              Historia
            </Link>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}

function SocialLink({ href, label, children }: { href?: string | null; label: string; children: React.ReactNode }) {
  if (!href?.trim()) {
    return null;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      className="grid size-9 place-items-center rounded-md border border-black/10 bg-white text-[#080808] hover:bg-[#f4f4f5]"
    >
      {children}
    </a>
  );
}


