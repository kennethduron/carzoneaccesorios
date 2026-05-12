"use client";

import Link from "next/link";
import { CarFront, Menu, ShoppingCart, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";

const links = [
  ["Inicio", "/"],
  ["Catálogo", "/catalogo"],
  ["Categorías", "/categorias"],
  ["Contacto", "/contacto"],
  ["Rastrear pedido", "/rastreo"],
  ["Mi cuenta", "/cuenta"],
  ["Facturas", "/facturas"],
];

export function PublicStoreShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [cartPulse, setCartPulse] = useState(false);
  const previousCartCount = useRef(0);
  const { priceMode } = usePriceMode();
  const { cartCount } = useShoppingCart();

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

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#f7f7f2] text-[#1c1d1b]">
      <header className="sticky top-0 z-40 border-b border-black/10 bg-[#f7f7f2]/95 backdrop-blur">
        <div className="relative mx-auto flex max-w-7xl items-center justify-between gap-2 px-5 py-4 sm:gap-4">
          <Link href="/" className="flex min-w-0 flex-1 items-center gap-3 pr-24 sm:pr-0">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-[#171717] text-white">
              <CarFront size={24} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-lg font-semibold">Car Zone Accesorios</span>
              <span className="block text-xs text-black/55">Accesorios automotrices</span>
            </span>
          </Link>

          <nav className="hidden items-center gap-1 lg:flex">
            {links.map(([label, href]) => (
              <Link key={href} href={href} className="rounded-md px-3 py-2 text-sm hover:bg-white">
                {label}
              </Link>
            ))}
          </nav>

          <div className="fixed right-5 top-4 z-50 flex shrink-0 items-center gap-2 sm:static sm:z-auto">
            <span className="hidden rounded-md border border-black/10 bg-white px-3 py-2 text-sm sm:inline-flex">
              {priceMode === "wholesale" ? "Precio mayorista activo" : "Precio al detalle activo"}
            </span>
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
              {links.map(([label, href]) => (
                <Link key={href} href={href} className="rounded-md px-3 py-2 text-sm" onClick={() => setOpen(false)}>
                  {label}
                </Link>
              ))}
              <Link href="/mis-pedidos" className="rounded-md px-3 py-2 text-sm" onClick={() => setOpen(false)}>
                Mis pedidos
              </Link>
              <Link href="/seguimiento" className="rounded-md px-3 py-2 text-sm" onClick={() => setOpen(false)}>
                Seguimiento
              </Link>
            </div>
          </nav>
        ) : null}
      </header>
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
