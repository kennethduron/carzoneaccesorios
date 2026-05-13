"use client";

import Link from "next/link";
import { CarFront, ChevronDown, LogIn, LogOut, Menu, ShoppingCart, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";
import { getSupabaseBrowserClient } from "@/lib/supabase";

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
    <main className="min-h-screen overflow-x-hidden bg-[#f7f7f2] text-[#1c1d1b]">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-black/10 bg-white/95 shadow-sm backdrop-blur">
        <div className="relative mx-auto flex max-w-7xl items-center justify-between gap-2 px-5 py-4 sm:gap-4">
          <Link href="/" className="flex min-w-0 flex-1 items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-[#171717] text-white">
              <CarFront size={24} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-lg font-semibold">Car Zone Accesorios</span>
              <span className="block text-xs text-black/55">Accesorios automotrices</span>
            </span>
          </Link>

          <nav className="hidden items-center gap-1 lg:flex">
            {primaryLinks.map(([label, href]) => (
              <Link key={href} href={href} className="rounded-md px-3 py-2 text-sm hover:bg-white">
                {label}
              </Link>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-2">
            {priceMode === "wholesale" ? (
              <span className="hidden rounded-md border border-[#246a73]/25 bg-white px-3 py-2 text-sm font-medium text-[#246a73] sm:inline-flex">
                Mayoreo activo
              </span>
            ) : null}

            <div ref={userMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setUserMenuOpen((current) => !current)}
                className="inline-flex h-10 items-center justify-center gap-1 rounded-md border border-black/10 bg-white px-3 text-sm hover:bg-white/80"
                aria-label="Abrir menu de usuario"
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
                      className="block px-4 py-2 text-sm hover:bg-[#f7f7f2]"
                      onClick={() => setUserMenuOpen(false)}
                    >
                      {label}
                    </Link>
                  ))}

                  <div className="mt-2 border-t border-black/10 pt-2">
                    {isAuthenticated ? (
                      <form action="/auth/logout" method="post">
                        <button type="submit" className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-[#f7f7f2]">
                          <LogOut size={16} />
                          Cerrar sesión
                        </button>
                      </form>
                    ) : (
                      <Link
                        href="/login"
                        className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-[#f7f7f2]"
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
              className={`inline-flex h-10 shrink-0 items-center justify-center gap-1 rounded-md bg-[#1c1d1b] px-3 text-sm text-white transition-transform sm:gap-2 ${
                cartPulse ? "scale-110 ring-4 ring-[#246a73]/20" : ""
              }`}
            >
              <ShoppingCart size={16} />
              <span>{cartCount}</span>
            </Link>
            <button
              onClick={() => setOpen((current) => !current)}
              className="grid size-10 place-items-center rounded-md border border-black/10 bg-white lg:hidden"
              aria-label="Abrir menu"
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
                <span className="rounded-md px-3 py-2 text-sm font-medium text-[#246a73]">Mayoreo activo</span>
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
      <div className="h-[73px]" aria-hidden="true" />
      {children}
      <footer className="border-t border-black/10 bg-white">
        <div className="mx-auto grid max-w-7xl gap-6 px-5 py-8 md:grid-cols-[1fr_auto]">
          <div>
            <p className="font-semibold">Car Zone Accesorios</p>
            <p className="mt-2 max-w-xl text-sm text-black/55">
              Tienda profesional de accesorios automotrices con precios retail y mayoristas reales.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <Link href="/mision" className="rounded-md px-3 py-2 hover:bg-[#f7f7f2]">
              Mision
            </Link>
            <Link href="/vision" className="rounded-md px-3 py-2 hover:bg-[#f7f7f2]">
              Vision
            </Link>
            <Link href="/historia" className="rounded-md px-3 py-2 hover:bg-[#f7f7f2]">
              Historia
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
