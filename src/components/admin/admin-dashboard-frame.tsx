"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Banknote,
  BarChart3,
  Bell,
  ChevronRight,
  ClipboardList,
  FileText,
  Headphones,
  Home,
  Menu,
  Package,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  User,
  Users,
  Wrench,
} from "lucide-react";

export type AdminDashboardIconKey =
  | "admin"
  | "crm"
  | "finance"
  | "home"
  | "inventory"
  | "operation"
  | "reports"
  | "security"
  | "settings"
  | "support"
  | "technical"
  | "sales";

export type AdminDashboardNavSection = {
  title: string;
  items: Array<{
    label: string;
    href: string;
    icon: AdminDashboardIconKey;
    visible: boolean;
  }>;
};

export type AdminDashboardSearchModule = {
  title: string;
  href: string;
  description: string;
  groupTitle: string;
};

export type AdminDashboardNotificationItem = {
  id: string;
  title: string;
  detail: string;
  href: string;
  tone: "danger" | "warning" | "info";
};

type Props = {
  navSections: AdminDashboardNavSection[];
  searchModules: AdminDashboardSearchModule[];
  notifications: AdminDashboardNotificationItem[];
  profileLabel: string;
  roleText: string;
  avatarLetter: string;
  logoutSlot: ReactNode;
  children: ReactNode;
};

const iconMap: Record<AdminDashboardIconKey, LucideIcon> = {
  admin: ShieldCheck,
  crm: Users,
  finance: Banknote,
  home: Home,
  inventory: Package,
  operation: ClipboardList,
  reports: BarChart3,
  security: ShieldCheck,
  settings: Settings,
  support: Headphones,
  technical: Wrench,
  sales: ShoppingCart,
};

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function toneClass(tone: AdminDashboardNotificationItem["tone"]) {
  if (tone === "danger") return "bg-[#fdecec] text-[#a33a2d]";
  if (tone === "warning") return "bg-[#fff7ed] text-[#7c2d12]";
  return "bg-[#eaf2ff] text-[#2563eb]";
}

export function AdminDashboardFrame({
  navSections,
  searchModules,
  notifications,
  profileLabel,
  roleText,
  avatarLetter,
  logoutSlot,
  children,
}: Props) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setCollapsed(window.localStorage.getItem("carzone:admin-sidebar-collapsed") === "true");
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("carzone:admin-sidebar-collapsed", String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        searchRef.current?.focus();
      }

      if (event.key === "Escape") {
        setSearchOpen(false);
        setNotificationsOpen(false);
        setDrawerOpen(false);
      }
    }

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (searchWrapRef.current && !searchWrapRef.current.contains(target)) {
        setSearchOpen(false);
      }
      if (notificationRef.current && !notificationRef.current.contains(target)) {
        setNotificationsOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, []);

  const results = useMemo(() => {
    const needle = normalize(query);
    const matches = needle
      ? searchModules.filter((module) =>
          normalize(`${module.title} ${module.description} ${module.groupTitle}`).includes(needle),
        )
      : searchModules;

    return matches.slice(0, 8);
  }, [query, searchModules]);


  function openResult(href: string) {
    setQuery("");
    setSearchOpen(false);
    router.push(href);
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResult((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResult((current) => Math.max(current - 1, 0));
    }

    if (event.key === "Enter" && results[activeResult]) {
      event.preventDefault();
      openResult(results[activeResult].href);
    }
  }

  return (
    <>
      {drawerOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[1px] xl:hidden"
          aria-label="Cerrar menu"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <DashboardSidebar sections={navSections} collapsed={collapsed} drawerOpen={drawerOpen} onNavigate={() => setDrawerOpen(false)} />

      <div className={`min-h-screen transition-[padding] duration-200 ${collapsed ? "xl:pl-20" : "xl:pl-60"}`}>
        <header className="sticky top-0 z-30 border-b border-black/10 bg-white/95 backdrop-blur">
          <div className="mx-auto flex min-h-16 w-full max-w-[1680px] items-center gap-2 px-3 py-2 sm:px-5 lg:px-6">
            <button
              type="button"
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-black/10 text-black/70 xl:hidden"
              aria-label="Abrir menu"
              onClick={() => setDrawerOpen(true)}
            >
              <Menu size={19} />
            </button>
            <button
              type="button"
              className="hidden size-10 shrink-0 items-center justify-center rounded-md border border-black/10 text-black/55 transition-colors hover:border-[#e4252c] hover:text-[#e4252c] xl:inline-flex"
              aria-label={collapsed ? "Expandir menu" : "Colapsar menu"}
              onClick={() => setCollapsed((current) => !current)}
            >
              <Menu size={18} />
            </button>

            <div ref={searchWrapRef} className="relative order-3 w-full min-w-0 flex-[1_0_100%] md:order-none md:flex-1 xl:max-w-xl">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-black/45" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                onKeyDown={onSearchKeyDown}
                type="search"
                placeholder="Buscar en todo el sistema..."
                className="h-10 w-full rounded-md border border-black/10 bg-[#fafafa] pl-9 pr-16 text-sm text-[#080808] outline-none transition-colors placeholder:text-black/40 focus:border-[#e4252c] focus:bg-white"
                aria-label="Buscar modulos del sistema"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-black/10 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-black/35">
                Ctrl K
              </span>
              {searchOpen ? (
                <div className="absolute left-0 right-0 top-12 z-50 overflow-hidden rounded-md border border-black/10 bg-white shadow-xl shadow-black/10">
                  <div className="max-h-80 overflow-y-auto p-1">
                    {results.length > 0 ? (
                      results.map((result, index) => (
                        <button
                          key={`${result.groupTitle}-${result.title}-${result.href}`}
                          type="button"
                          onMouseEnter={() => setActiveResult(index)}
                          onClick={() => openResult(result.href)}
                          className={`block w-full rounded-md px-3 py-2 text-left transition-colors ${
                            index === activeResult ? "bg-[#fff1f2] text-[#e4252c]" : "hover:bg-[#fafafa]"
                          }`}
                        >
                          <span className="block text-sm font-semibold">{result.title}</span>
                          <span className="mt-0.5 block text-xs text-black/50">{result.groupTitle}</span>
                          <span className="mt-1 line-clamp-2 text-xs leading-5 text-black/55">{result.description}</span>
                        </button>
                      ))
                    ) : (
                      <p className="px-3 py-4 text-sm text-black/55">Sin resultados</p>
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="ml-auto flex min-w-0 items-center gap-2">
              <div ref={notificationRef} className="relative">
                <button
                  type="button"
                  className="relative inline-flex size-10 items-center justify-center rounded-md text-black/65 transition-colors hover:bg-[#fafafa]"
                  aria-label="Notificaciones"
                  aria-expanded={notificationsOpen}
                  onClick={() => setNotificationsOpen((current) => !current)}
                >
                  <Bell size={18} />
                  {notifications.length > 0 ? (
                    <span className="absolute right-1.5 top-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-[#e4252c] px-1 text-[10px] font-semibold leading-4 text-white">
                      {Math.min(notifications.length, 9)}
                    </span>
                  ) : null}
                </button>
                {notificationsOpen ? (
                  <div className="absolute right-0 top-12 z-50 w-[min(92vw,360px)] overflow-hidden rounded-md border border-black/10 bg-white shadow-xl shadow-black/10">
                    <div className="flex items-center justify-between gap-3 border-b border-black/10 px-4 py-3">
                      <h2 className="text-sm font-semibold">Notificaciones</h2>
                      <span className="rounded-full bg-[#f4f4f5] px-2 py-1 text-xs font-semibold text-black/55">
                        {notifications.length.toLocaleString("es-HN")}
                      </span>
                    </div>
                    <div className="max-h-96 overflow-y-auto p-2">
                      {notifications.length > 0 ? (
                        notifications.map((item) => (
                          <Link
                            key={item.id}
                            href={item.href}
                            onClick={() => setNotificationsOpen(false)}
                            className="flex gap-3 rounded-md p-2 transition-colors hover:bg-[#fafafa]"
                          >
                            <span className={`mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md ${toneClass(item.tone)}`}>
                              {item.tone === "info" ? <FileText size={15} /> : <AlertTriangle size={15} />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-semibold">{item.title}</span>
                              <span className="mt-1 line-clamp-2 text-xs leading-5 text-black/55">{item.detail}</span>
                            </span>
                          </Link>
                        ))
                      ) : (
                        <p className="px-3 py-6 text-sm text-black/55">No hay alertas pendientes</p>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="hidden h-8 w-px bg-black/10 lg:block" />
              <div className="hidden min-w-0 items-center gap-2 lg:flex">
                <span className="inline-flex size-8 items-center justify-center rounded-md bg-[#f4f4f5] text-black/55">
                  <User size={16} />
                </span>
                <span className="min-w-0 text-xs">
                  <span className="block max-w-[220px] truncate font-semibold">{profileLabel}</span>
                  <span className="block capitalize text-black/50">{roleText}</span>
                </span>
              </div>
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-[#e4252c] text-xs font-semibold text-white">
                {avatarLetter}
              </span>
              <div className="hidden sm:block">{logoutSlot}</div>
            </div>
          </div>
        </header>

        {children}
      </div>
    </>
  );
}

function DashboardSidebar({
  sections,
  collapsed,
  drawerOpen,
  onNavigate,
}: {
  sections: AdminDashboardNavSection[];
  collapsed: boolean;
  drawerOpen: boolean;
  onNavigate: () => void;
}) {
  const desktopClass = collapsed ? "xl:w-20 xl:px-3" : "xl:w-60 xl:px-4";

  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[min(88vw,300px)] -translate-x-full flex-col border-r border-black/10 bg-white transition-transform duration-200 xl:hidden ${
          drawerOpen ? "translate-x-0" : ""
        }`}
        aria-label="Menu movil"
      >
        <SidebarContent sections={sections} collapsed={false} onNavigate={onNavigate} />
      </aside>
      <aside
        className={`fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-black/10 bg-white transition-[width,padding] duration-200 xl:flex ${desktopClass}`}
        aria-label="Menu principal"
      >
        <SidebarContent sections={sections} collapsed={collapsed} onNavigate={onNavigate} />
      </aside>
    </>
  );
}

function SidebarContent({
  sections,
  collapsed,
  onNavigate,
}: {
  sections: AdminDashboardNavSection[];
  collapsed: boolean;
  onNavigate: () => void;
}) {
  return (
    <>
      <div className={`flex h-20 items-center ${collapsed ? "justify-center" : "justify-between px-1"}`}>
        <Link href="/admin" onClick={onNavigate} className="flex min-w-0 items-center gap-3" aria-label="Ir al inicio del panel">
          <Image
            src="/brand/car-zone-logo-nav.png"
            alt="Car Zone Accesorios"
            width={150}
            height={42}
            className={collapsed ? "h-auto w-11 object-contain" : "h-auto w-[145px] object-contain"}
          />
        </Link>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto pb-3">
        <SidebarLink href="/admin" label="Inicio" icon="home" collapsed={collapsed} onNavigate={onNavigate} active />
        {sections.map((section) => {
          const items = section.items.filter((item) => item.visible);
          if (items.length === 0) return null;

          return (
            <div key={section.title} className={collapsed ? "mb-3" : "mb-5"}>
              {collapsed ? null : <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-normal text-black/45">{section.title}</p>}
              <div className="space-y-1">
                {items.map((item) => (
                  <SidebarLink key={`${section.title}-${item.label}`} {...item} collapsed={collapsed} onNavigate={onNavigate} />
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      {collapsed ? null : (
        <div className="p-1 pb-4">
          <Link
            href="/admin/ayuda"
            onClick={onNavigate}
            className="flex flex-col items-center rounded-lg border border-[#e4252c]/20 bg-[#fff1f2] p-3 text-center shadow-sm"
          >
            <span className="inline-flex size-10 items-center justify-center rounded-full bg-white text-[#e4252c] shadow-sm">
              <Headphones size={20} />
            </span>
            <span className="mt-2 text-sm font-semibold">Soporte tecnico</span>
            <span className="mt-1 text-xs text-black/55">Necesitas ayuda?</span>
            <span className="mt-3 rounded-md border border-[#e4252c]/30 bg-white px-3 py-2 text-xs font-semibold text-[#e4252c]">
              Contactar soporte
            </span>
          </Link>
        </div>
      )}
    </>
  );
}

function SidebarLink({
  href,
  label,
  icon,
  collapsed,
  onNavigate,
  active = false,
}: {
  href: string;
  label: string;
  icon: AdminDashboardIconKey;
  collapsed: boolean;
  onNavigate: () => void;
  active?: boolean;
}) {
  const Icon = iconMap[icon] ?? ChevronRight;

  return (
    <Link
      href={href}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={`flex items-center rounded-md text-sm font-medium transition-colors hover:bg-[#fafafa] hover:text-[#e4252c] ${
        collapsed ? "justify-center px-2 py-3" : "gap-3 px-3 py-2.5"
      } ${active ? "bg-[#fff1f2] font-semibold text-[#e4252c]" : "text-black/75"}`}
    >
      <Icon size={16} className={active ? "text-[#e4252c]" : "text-black/55"} />
      {collapsed ? null : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ChevronRight size={14} className="text-black/35" />
        </>
      )}
    </Link>
  );
}
