"use client";

import Image from "next/image";
import Link from "next/link";
import { CheckCircle2, ChevronDown, LogIn, LogOut, Menu, ShoppingCart, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getPublicAccountMenuStateAction, type PublicAccountMenuState } from "@/app/actions/account-menu";
import { getWholesaleAccessStateAction, markWholesaleApprovedNoticeSeenAction } from "@/app/actions/wholesale";
import { CardBrandList } from "@/components/store/card-brand-list";
import { SocialLinks } from "@/components/store/social-links";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useShoppingCart } from "@/contexts/cart-context";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { getPublicCompanySettingsClient } from "@/services/supabase/company-settings-client.service";
import type { PublicCompanySettings } from "@/types/settings";

const primaryLinks = [
  ["Inicio", "/"],
  ["Catálogo", "/catalogo"],
  ["Contacto", "/contacto"],
  ["Rastrear pedido", "/rastreo"],
  ["Solicitar mayoreo", "/contacto#mayoreo"],
];

const customerAccountLinks = [
  ["Mi cuenta", "/cuenta"],
  ["Mis pedidos", "/mis-pedidos"],
  ["Facturas", "/facturas"],
];

const legalLinks = [
  ["Términos y condiciones", "/terminos-y-condiciones"],
  ["Política de privacidad", "/politica-de-privacidad"],
  ["Política de entrega", "/politica-de-entrega"],
  ["Política de devoluciones", "/politica-de-devoluciones"],
  ["Política de cancelación", "/politica-de-cancelacion"],
  ["Servicio al cliente", "/contacto-servicio-cliente"],
  ["Contacto", "/contacto"],
];

const guestAccountState: PublicAccountMenuState = {
  isAuthenticated: false,
  role: null,
  hasAdminAccess: false,
};

export function PublicStoreShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [accountState, setAccountState] = useState<PublicAccountMenuState>(guestAccountState);
  const [showWholesaleApprovedNotice, setShowWholesaleApprovedNotice] = useState(false);
  const [cartPulse, setCartPulse] = useState(false);
  const [companySettings, setCompanySettings] = useState<PublicCompanySettings | null>(null);
  const previousCartCount = useRef(0);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const { priceMode, activateWholesaleMode, clearWholesaleMode } = usePriceMode();
  const { cartCount } = useShoppingCart();

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let active = true;

    async function refreshAccountState(hasSession: boolean) {
      if (!active) {
        return;
      }

      if (!hasSession) {
        setAccountState(guestAccountState);
        clearWholesaleMode();
        return;
      }

      const [state, wholesaleState] = await Promise.all([getPublicAccountMenuStateAction(), getWholesaleAccessStateAction()]);
      if (active) {
        setAccountState(state);
        if (wholesaleState.account) {
          activateWholesaleMode(wholesaleState.account);
          setShowWholesaleApprovedNotice(wholesaleState.shouldShowApprovedNotice);
        } else {
          clearWholesaleMode();
          setShowWholesaleApprovedNotice(false);
        }
      }
    }

    supabase.auth.getSession().then(({ data }) => {
      const hasSession = Boolean(data.session);
      if (!hasSession) {
        clearWholesaleMode();
      }
      void refreshAccountState(hasSession);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const hasSession = Boolean(session);
      if (!hasSession) {
        clearWholesaleMode();
      }
      void refreshAccountState(hasSession);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [activateWholesaleMode, clearWholesaleMode]);

  useEffect(() => {
    let active = true;

    getPublicCompanySettingsClient().then((settings) => {
      if (active) {
        setCompanySettings(settings);
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
      const target = event.target as Node;
      if (!userMenuRef.current?.contains(target)) {
        setUserMenuOpen(false);
      }
      if (!mobileMenuRef.current?.contains(target) && !mobileMenuButtonRef.current?.contains(target)) {
        setOpen(false);
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

  const tradeName = companySettings?.trade_name || companySettings?.company_name || "Car Zone Accesorios";

  async function closeWholesaleApprovedNotice() {
    setShowWholesaleApprovedNotice(false);
    await markWholesaleApprovedNoticeSeenAction();
  }

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

          <nav className="hidden items-center gap-1 xl:flex">
            {primaryLinks.map(([label, href]) => (
              <Link key={href} href={href} className="rounded-md px-3 py-2 text-sm hover:bg-[#f4f4f5]">
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
                onClick={() => {
                  setUserMenuOpen((current) => !current);
                  setOpen(false);
                }}
                className="inline-flex h-10 items-center justify-center gap-1 rounded-md border border-black/10 bg-white px-2.5 text-sm hover:bg-white/80 sm:px-3"
                aria-label="Abrir menu de usuario"
                aria-expanded={userMenuOpen}
              >
                <UserRound size={17} />
                <ChevronDown size={14} className={`transition-transform ${userMenuOpen ? "rotate-180" : ""}`} />
              </button>

              {userMenuOpen ? (
                <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-md border border-black/10 bg-white py-2 shadow-xl">
                  {accountState.isAuthenticated ? (
                    <>
                      {accountState.hasAdminAccess ? (
                        <Link
                          href="/admin"
                          className="block px-4 py-2 text-sm font-medium hover:bg-[#f4f4f5]"
                          onClick={() => setUserMenuOpen(false)}
                        >
                          Panel administrativo
                        </Link>
                      ) : null}
                      {(accountState.hasAdminAccess ? [["Mi cuenta", "/cuenta"]] : customerAccountLinks).map(([label, href]) => (
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
                        <form action="/auth/logout" method="post">
                          <button type="submit" className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-[#f4f4f5]">
                            <LogOut size={16} />
                            Cerrar sesión
                          </button>
                        </form>
                      </div>
                    </>
                  ) : (
                    <>
                      <Link
                        href="/login"
                        className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-[#f4f4f5]"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        <LogIn size={16} />
                        Iniciar sesión
                      </Link>
                      <Link
                        href="/registro"
                        className="block px-4 py-2 text-sm hover:bg-[#f4f4f5]"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        Crear cuenta
                      </Link>
                    </>
                  )}
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
              ref={mobileMenuButtonRef}
              onClick={() => {
                setOpen((current) => !current);
                setUserMenuOpen(false);
              }}
              className="grid size-10 place-items-center rounded-md border border-black/10 bg-white xl:hidden"
              aria-label="Abrir menu principal"
              aria-expanded={open}
            >
              {open ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>

        {open ? (
          <nav ref={mobileMenuRef} className="border-t border-black/10 bg-white px-5 py-3 xl:hidden">
            <div className="mx-auto grid max-w-7xl gap-1">
              {primaryLinks.map(([label, href]) => (
                <Link key={href} href={href} className="rounded-md px-3 py-2 text-sm" onClick={() => setOpen(false)}>
                  {label}
                </Link>
              ))}
              {priceMode === "wholesale" ? (
                <span className="rounded-md px-3 py-2 text-sm font-medium text-[#e4252c]">Mayoreo activo</span>
              ) : null}
            </div>
          </nav>
        ) : null}
      </header>
      <div className="h-16 sm:h-[70px]" aria-hidden="true" />
      {children}
      {showWholesaleApprovedNotice ? (
        <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/45 px-4">
          <section className="w-full max-w-lg rounded-lg bg-white p-5 text-[#080808] shadow-xl">
            <div className="flex items-start gap-3">
              <div className="grid size-11 shrink-0 place-items-center rounded-md bg-[#fff1f2] text-[#b91c25]">
                <CheckCircle2 size={22} />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-semibold">Tu cuenta mayorista fue aprobada</h2>
                <p className="mt-2 text-sm leading-6 text-black/65">
                  Ya tienes acceso a precios mayoristas. Los precios se aplicarán automáticamente en el catálogo, carrito y checkout.
                </p>
              </div>
              <button
                type="button"
                onClick={closeWholesaleApprovedNotice}
                className="grid size-8 shrink-0 place-items-center rounded-md text-black/45 hover:bg-black/5"
                aria-label="Cerrar aviso mayorista"
              >
                <X size={16} />
              </button>
            </div>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={closeWholesaleApprovedNotice}
                className="rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white"
              >
                Entendido
              </button>
            </div>
          </section>
        </div>
      ) : null}
      <footer className="border-t border-black/10 bg-white">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 py-10 lg:grid-cols-[1.2fr_1fr_1fr]">
          <div>
            <p className="font-semibold">{tradeName}</p>
            <p className="mt-2 max-w-xl text-sm text-black/55">
              Tienda profesional de accesorios automotrices con precios al detalle y mayoristas reales.
            </p>
            <div className="mt-4 space-y-1 text-sm text-black/55">
              {companySettings?.business_address ? <p>{companySettings.business_address}</p> : null}
              {companySettings?.customer_service_phone ? <p>{companySettings.customer_service_phone}</p> : null}
              {companySettings?.customer_service_email ? <p>{companySettings.customer_service_email}</p> : null}
              {companySettings?.customer_service_hours ? <p>{companySettings.customer_service_hours}</p> : null}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold">Políticas y soporte</p>
            <div className="grid gap-1 text-sm">
              {legalLinks.map(([label, href]) => (
                <Link key={href} href={href} className="rounded-md px-3 py-2 text-black/65 hover:bg-[#f4f4f5] hover:text-[#080808]">
                  {label}
                </Link>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold">Siguenos</p>
            <div className="mb-5">
              <SocialLinks settings={companySettings} />
            </div>
            <p className="mb-2 text-sm font-semibold">Pagos seguros</p>
            <p className="mb-3 text-sm text-black/55">Pagos seguros procesados mediante pasarela bancaria autorizada.</p>
            <CardBrandList compact />
          </div>
        </div>
        <div className="border-t border-black/10 px-5 py-4">
          <div className="mx-auto flex max-w-7xl flex-wrap gap-2 text-sm text-black/55">
            <Link href="/mision" className="rounded-md px-3 py-2 hover:bg-[#f4f4f5]">
              Mision
            </Link>
            <Link href="/vision" className="rounded-md px-3 py-2 hover:bg-[#f4f4f5]">
              Vision
            </Link>
            <Link href="/historia" className="rounded-md px-3 py-2 hover:bg-[#f4f4f5]">
              Historia
            </Link>
            <Link href="/politicas" className="rounded-md px-3 py-2 hover:bg-[#f4f4f5]">
              Políticas
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
