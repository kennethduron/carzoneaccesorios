import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { PushNotificationRuntime } from "@/components/admin/push-notification-runtime";

type AdminShellProps = {
  title: string;
  children: ReactNode;
  variant?: "default" | "dashboard" | "wide";
  backHref?: string;
  backLabel?: string;
  eyebrow?: string;
  description?: string;
};

export function AdminShell({ title, children, variant = "default", backHref, backLabel = "Volver al inicio", eyebrow = "Panel administrativo", description }: AdminShellProps) {
  if (variant === "dashboard") {
    return (
      <section className="min-h-screen overflow-x-clip bg-[#f4f4f5] text-[#080808]">
        {children}
        <PushNotificationRuntime />
      </section>
    );
  }

  const isWide = variant === "wide";

  return (
    <section className="min-h-screen overflow-x-clip bg-[#f4f4f5] px-3 py-4 text-[#080808] sm:px-5 sm:py-6">
      <div className={`mx-auto w-full min-w-0 ${variant === "wide" ? "max-w-[1800px]" : "max-w-7xl"}`}>
        <div data-testid={isWide ? "pos-admin-header" : undefined} className={`${isWide ? "mb-3 px-4 py-3 sm:mb-5 sm:px-5 sm:py-4" : "mb-4 px-4 py-4 sm:mb-6 sm:px-5"} rounded-xl bg-[#080808] text-white shadow-lg shadow-black/10`}>
          <div className={isWide ? "grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3" : "flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"}>
            <div className="min-w-0"><p className="text-xs font-semibold uppercase text-[#e4252c]">{eyebrow}</p><h1 className={`${isWide ? "mt-0.5 text-xl leading-tight sm:mt-1 sm:text-2xl" : "mt-1 text-2xl"} break-normal font-semibold [overflow-wrap:break-word]`}>{title}</h1>{description ? <p className="mt-0.5 text-sm text-white/65">{description}</p> : null}</div>
            {backHref ? <Link href={backHref} className={`${isWide ? "gap-1.5 px-3 text-xs sm:gap-2 sm:px-4 sm:text-sm" : "gap-2 px-4 text-sm"} inline-flex min-h-11 w-fit shrink-0 items-center rounded-lg border border-white/25 font-semibold text-white transition hover:border-white/60 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white`}><ArrowLeft size={18} /> {backLabel}</Link> : null}
          </div>
        </div>
        <div className={`${isWide ? "mt-3 sm:mt-5" : "mt-6"} min-w-0`}>{children}</div>
      </div>
      <PushNotificationRuntime />
    </section>
  );
}
