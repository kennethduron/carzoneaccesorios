"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  markAdminDashboardNotificationReadAction,
  markAllAdminDashboardNotificationsReadAction,
} from "@/app/admin/actions";
import { LogoutMenuItemProvider } from "@/components/auth/logout-button";
import { useToast } from "@/contexts/toast-context";
import {
  addTokenSyncedListener,
  getPermissionStatus,
  registerDeviceToken,
  requestNotificationPermission,
  type PushPermissionStatus,
} from "@/lib/firebase/push-client";
import {
  AlertTriangle,
  Banknote,
  BarChart3,
  Bell,
  BellRing,
  CheckCircle2,
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
  XCircle,
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

type PushHeaderStatus = {
  ok?: boolean;
  canUsePush?: boolean;
  fcm?: {
    configured: boolean;
    webConfigured: boolean;
  };
  device?: {
    registered: boolean;
    tokenCount: number;
    lastSyncAt: string | null;
  };
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
  const toast = useToast();
  const searchRef = useRef<HTMLInputElement>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>([]);
  const [pendingNotificationIds, setPendingNotificationIds] = useState<string[]>([]);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [pushStatus, setPushStatus] = useState<PushHeaderStatus | null>(null);
  const [pushPermission, setPushPermission] = useState<PushPermissionStatus>("unsupported");
  const [pushLoading, setPushLoading] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);

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
    const notification = notifications.find((item) => {
      if (!item.id.startsWith("internal:")) return false;
      return window.sessionStorage.getItem(`carzone:admin-notification-toasted:${item.id}`) !== "1";
    });

    if (!notification) return;

    window.sessionStorage.setItem(`carzone:admin-notification-toasted:${notification.id}`, "1");
    if (notification.tone === "danger") toast.error(notification.title);
    else if (notification.tone === "warning") toast.warning(notification.title);
    else toast.info(notification.title);
  }, [notifications, toast]);

  useEffect(() => {
    const desktopMedia = window.matchMedia("(min-width: 640px)");

    function onBreakpointChange(event: MediaQueryListEvent) {
      if (event.matches) setIsUserMenuOpen(false);
    }

    desktopMedia.addEventListener("change", onBreakpointChange);
    return () => desktopMedia.removeEventListener("change", onBreakpointChange);
  }, []);

  useEffect(() => {
    let active = true;

    function refreshPushStatus() {
      setPushPermission(getPermissionStatus());
      fetch("/api/admin/push/status", { credentials: "same-origin", cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: PushHeaderStatus | null) => {
          if (active) setPushStatus(payload);
        })
        .catch(() => {
          if (active) setPushStatus(null);
        });
    }

    refreshPushStatus();
    const removeTokenListener = addTokenSyncedListener(refreshPushStatus);

    return () => {
      active = false;
      removeTokenListener();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsUserMenuOpen(false);
        setSearchOpen(true);
        searchRef.current?.focus();
      }

      if (event.key === "Escape") {
        const restoreUserMenuFocus = isUserMenuOpen;
        setSearchOpen(false);
        setNotificationsOpen(false);
        setDrawerOpen(false);
        setIsUserMenuOpen(false);
        if (restoreUserMenuFocus) {
          window.requestAnimationFrame(() => userMenuButtonRef.current?.focus());
        }
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
      if (userMenuRef.current && !userMenuRef.current.contains(target)) {
        setIsUserMenuOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [isUserMenuOpen]);

  const results = useMemo(() => {
    const needle = normalize(query);
    const matches = needle
      ? searchModules.filter((module) =>
          normalize(`${module.title} ${module.description} ${module.groupTitle}`).includes(needle),
        )
      : searchModules;

    return matches.slice(0, 8);
  }, [query, searchModules]);

  const visibleNotifications = useMemo(() => {
    const readIds = new Set(readNotificationIds);
    return notifications.filter((item) => !readIds.has(item.id));
  }, [notifications, readNotificationIds]);

  const pushConfigured = Boolean(pushStatus?.canUsePush && pushStatus.fcm?.configured && pushStatus.fcm.webConfigured);
  const pushRegistered = pushPermission === "granted" && Boolean(pushStatus?.device?.registered);
  const pushBlocked = pushPermission === "denied";
  const pushUnsupported = pushPermission === "unsupported";

  async function activatePushNotifications() {
    setPushMessage(null);

    if (!pushStatus?.canUsePush) {
      setPushMessage("Tu rol no tiene notificaciones administrativas disponibles.");
      return;
    }

    if (!pushStatus.fcm?.configured || !pushStatus.fcm.webConfigured) {
      setPushMessage("Las notificaciones todavía no están configuradas.");
      return;
    }

    if (getPermissionStatus() === "unsupported") {
      setPushPermission("unsupported");
      setPushMessage("Este navegador no admite notificaciones.");
      return;
    }

    setPushLoading(true);
    try {
      const nextPermission = await requestNotificationPermission();
      setPushPermission(nextPermission);

      if (nextPermission === "denied") {
        const message = "Permiso bloqueado. Actívalo desde la configuración del navegador.";
        setPushMessage(message);
        toast.warning(message);
        return;
      }

      if (nextPermission !== "granted") {
        const message = "Permiso de notificaciones no concedido.";
        setPushMessage(message);
        toast.warning(message);
        return;
      }

      const result = await registerDeviceToken();
      if (!result.ok) {
        setPushMessage(result.message);
        toast.error(result.message);
        return;
      }

      setPushStatus((current) => ({
        ...(current ?? {}),
        canUsePush: true,
        fcm: current?.fcm ?? { configured: true, webConfigured: true },
        device: {
          registered: true,
          tokenCount: Math.max(current?.device?.tokenCount ?? 0, 1),
          lastSyncAt: result.syncedAt ?? new Date().toISOString(),
        },
      }));
      setPushMessage(null);
      toast.success("Notificaciones activadas en este dispositivo.");
    } finally {
      setPushLoading(false);
    }
  }

  function setNotificationPending(ids: string[], pending: boolean) {
    setPendingNotificationIds((current) => {
      const next = new Set(current);
      ids.forEach((id) => {
        if (pending) next.add(id);
        else next.delete(id);
      });
      return Array.from(next);
    });
  }

  async function markNotificationRead(id: string) {
    const previousReadIds = readNotificationIds;
    setNotificationError(null);
    setReadNotificationIds((current) => Array.from(new Set([...current, id])));
    setNotificationPending([id], true);

    const result = await markAdminDashboardNotificationReadAction(id);
    if (!result.ok) {
      setReadNotificationIds(previousReadIds);
      setNotificationError("No se pudo marcar la notificación como leída.");
    }

    setNotificationPending([id], false);
    return result.ok;
  }

  async function markAllNotificationsRead() {
    const ids = visibleNotifications.map((item) => item.id);
    if (ids.length === 0) return;

    const previousReadIds = readNotificationIds;
    setNotificationError(null);
    setReadNotificationIds((current) => Array.from(new Set([...current, ...ids])));
    setNotificationPending(ids, true);

    const result = await markAllAdminDashboardNotificationsReadAction(ids);
    if (!result.ok) {
      setReadNotificationIds(previousReadIds);
      setNotificationError("No se pudieron marcar las notificaciones como leídas.");
    }

    setNotificationPending(ids, false);
  }

  async function openNotification(item: AdminDashboardNotificationItem) {
    const marked = await markNotificationRead(item.id);
    if (!marked) return;

    setNotificationsOpen(false);
    router.push(item.href);
  }

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
          aria-label="Cerrar menú"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <DashboardSidebar sections={navSections} collapsed={collapsed} drawerOpen={drawerOpen} onNavigate={() => setDrawerOpen(false)} />

      <div className={`min-h-screen transition-[padding] duration-200 ${collapsed ? "xl:pl-20" : "xl:pl-60"}`}>
        <header className="sticky top-0 z-40 border-b border-black/10 bg-white/95 backdrop-blur">
          <div className="mx-auto flex min-h-16 w-full max-w-[1680px] flex-wrap items-center gap-2 px-3 py-2 sm:px-5 md:flex-nowrap lg:px-6">
            <button
              type="button"
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-black/10 text-black/70 xl:hidden"
              aria-label="Abrir menú"
              onClick={() => {
                setIsUserMenuOpen(false);
                setDrawerOpen(true);
              }}
            >
              <Menu size={19} />
            </button>
            <button
              type="button"
              className="hidden size-10 shrink-0 items-center justify-center rounded-md border border-black/10 text-black/55 transition-colors hover:border-[#e4252c] hover:text-[#e4252c] xl:inline-flex"
              aria-label={collapsed ? "Expandir menú" : "Colapsar menú"}
              onClick={() => setCollapsed((current) => !current)}
            >
              <Menu size={18} />
            </button>

            <div ref={searchWrapRef} className="relative order-3 w-full min-w-0 basis-full md:order-none md:basis-auto md:flex-1 xl:max-w-xl">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-black/45" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveResult(0);
                  setIsUserMenuOpen(false);
                  setSearchOpen(true);
                }}
                onFocus={() => {
                  setIsUserMenuOpen(false);
                  setSearchOpen(true);
                }}
                onKeyDown={onSearchKeyDown}
                type="search"
                placeholder="Buscar en todo el sistema..."
                className="h-10 w-full rounded-md border border-black/10 bg-[#fafafa] pl-9 pr-4 text-sm text-[#080808] outline-none transition-colors placeholder:text-black/40 focus:border-[#e4252c] focus:bg-white md:pr-16"
                aria-label="Buscar módulos del sistema"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-black/10 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-black/35 md:inline-flex">
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
                  onClick={() => {
                    setIsUserMenuOpen(false);
                    setNotificationsOpen((current) => !current);
                  }}
                >
                  <Bell size={18} />
                  {visibleNotifications.length > 0 ? (
                    <span className="absolute right-1.5 top-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-[#e4252c] px-1 text-[10px] font-semibold leading-4 text-white">
                      {Math.min(visibleNotifications.length, 9)}
                    </span>
                  ) : null}
                </button>
                {notificationsOpen ? (
                  <div className="fixed left-3 right-3 top-[4.5rem] z-50 w-auto overflow-hidden rounded-md border border-black/10 bg-white shadow-xl shadow-black/10 sm:absolute sm:left-auto sm:right-0 sm:top-12 sm:w-[min(92vw,410px)]">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/10 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold">Notificaciones</h2>
                        <span className="rounded-full bg-[#f4f4f5] px-2 py-1 text-xs font-semibold text-black/55">
                          {visibleNotifications.length.toLocaleString("es-HN")}
                        </span>
                      </div>
                      {visibleNotifications.length > 0 ? (
                        <button
                          type="button"
                          className="rounded-md px-2 py-1 text-xs font-semibold text-[#e4252c] transition-colors hover:bg-[#fff1f2] disabled:cursor-wait disabled:opacity-60"
                          disabled={pendingNotificationIds.length > 0}
                          onClick={() => void markAllNotificationsRead()}
                        >
                          Marcar todas como leídas
                        </button>
                      ) : null}
                    </div>
                    {pushConfigured ? (
                      <div className="border-b border-black/10 px-4 py-3">
                        {pushRegistered ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#edf7ed] px-2.5 py-1 text-xs font-semibold text-[#2f6f3e]">
                            <CheckCircle2 size={14} />
                            Notificaciones activas
                          </span>
                        ) : pushBlocked ? (
                          <div className="flex items-start gap-2 rounded-md bg-[#fdecec] px-3 py-2 text-xs font-semibold leading-5 text-[#a33a2d]">
                            <XCircle size={15} className="mt-0.5 shrink-0" />
                            <span>Permiso bloqueado. Actívalo desde la configuración del navegador.</span>
                          </div>
                        ) : pushUnsupported ? (
                          <div className="flex items-start gap-2 rounded-md bg-[#f4f4f5] px-3 py-2 text-xs font-semibold leading-5 text-black/55">
                            <BellRing size={15} className="mt-0.5 shrink-0" />
                            <span>Este navegador no admite notificaciones.</span>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={pushLoading}
                            onClick={() => void activatePushNotifications()}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#080808] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#2a2a2a] disabled:cursor-wait disabled:opacity-60 sm:w-auto"
                          >
                            <BellRing size={16} />
                            {pushLoading ? "Activando..." : "Activar notificaciones"}
                          </button>
                        )}
                        {pushMessage ? <p className="mt-2 text-xs leading-5 text-black/55">{pushMessage}</p> : null}
                      </div>
                    ) : null}
                    {notificationError ? <p className="border-b border-black/10 px-4 py-2 text-xs font-semibold text-[#a33a2d]">{notificationError}</p> : null}
                    <div className="max-h-[calc(100dvh-13rem)] overflow-y-auto p-2 sm:max-h-96">
                      {visibleNotifications.length > 0 ? (
                        visibleNotifications.map((item) => {
                          const isPending = pendingNotificationIds.includes(item.id);

                          return (
                            <div key={item.id} className="rounded-md p-2 transition-colors hover:bg-[#fafafa]">
                              <Link
                                href={item.href}
                                onClick={(event) => {
                                  event.preventDefault();
                                  void openNotification(item);
                                }}
                                className="flex gap-3"
                              >
                                <span className={`mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md ${toneClass(item.tone)}`}>
                                  {item.tone === "info" ? <FileText size={15} /> : <AlertTriangle size={15} />}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-semibold">{item.title}</span>
                                  <span className="mt-1 block text-xs leading-5 text-black/55">{item.detail}</span>
                                </span>
                              </Link>
                              <button
                                type="button"
                                disabled={isPending}
                                className="ml-11 mt-1 rounded-md px-2 py-1 text-xs font-semibold text-black/50 transition-colors hover:bg-[#fff1f2] hover:text-[#e4252c] disabled:cursor-wait disabled:opacity-60"
                                onClick={() => void markNotificationRead(item.id)}
                              >
                                {isPending ? "Guardando..." : "Marcar como leída"}
                              </button>
                            </div>
                          );
                        })
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
              <div ref={userMenuRef} className="relative flex shrink-0 items-center gap-2">
                <button
                  ref={userMenuButtonRef}
                  type="button"
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-[#e4252c] text-xs font-semibold text-white outline-none transition-colors hover:bg-[#b91c25] focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2 sm:hidden"
                  aria-label="Abrir menú de usuario"
                  aria-haspopup="menu"
                  aria-expanded={isUserMenuOpen}
                  aria-controls="admin-mobile-user-menu"
                  onClick={() => {
                    const nextOpen = !isUserMenuOpen;
                    if (nextOpen) {
                      setSearchOpen(false);
                      setNotificationsOpen(false);
                      setDrawerOpen(false);
                    }
                    setIsUserMenuOpen(nextOpen);
                  }}
                >
                  {avatarLetter}
                </button>
                <span className="hidden size-9 shrink-0 items-center justify-center rounded-full bg-[#e4252c] text-xs font-semibold text-white sm:inline-flex">
                  {avatarLetter}
                </span>
                {isUserMenuOpen ? (
                  <div
                    id="admin-mobile-user-menu"
                    role="menu"
                    onSubmitCapture={() => {
                      window.requestAnimationFrame(() => setIsUserMenuOpen(false));
                    }}
                    className="absolute right-0 top-full z-50 mt-2 w-44 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md border border-black/10 bg-white p-1 shadow-xl shadow-black/10 sm:hidden"
                  >
                    <LogoutMenuItemProvider>{logoutSlot}</LogoutMenuItemProvider>
                  </div>
                ) : null}
                <div className="hidden sm:block">{logoutSlot}</div>
              </div>
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
        aria-label="Menú móvil"
      >
        <SidebarContent sections={sections} collapsed={false} onNavigate={onNavigate} />
      </aside>
      <aside
        className={`fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-black/10 bg-white transition-[width,padding] duration-200 xl:flex ${desktopClass}`}
        aria-label="Menú principal"
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
            <span className="mt-2 text-sm font-semibold">Soporte técnico</span>
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
