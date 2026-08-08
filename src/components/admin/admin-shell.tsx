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
};

export function AdminShell({ title, children, variant = "default", backHref, backLabel = "Volver al inicio" }: AdminShellProps) {
  if (variant === "dashboard") {
    return (
      <section className="min-h-screen overflow-x-clip bg-[#f4f4f5] text-[#080808]">
        {children}
        <PushNotificationRuntime />
      </section>
    );
  }

  return (
    <section className="min-h-screen overflow-x-clip bg-[#f4f4f5] px-3 py-4 text-[#080808] sm:px-5 sm:py-6">
      <div className={`mx-auto w-full min-w-0 ${variant === "wide" ? "max-w-[1800px]" : "max-w-7xl"}`}>
        <div className="mb-4 rounded-xl bg-[#080808] px-4 py-4 text-white shadow-lg shadow-black/10 sm:mb-6 sm:px-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-xs font-semibold uppercase text-[#e4252c]">Panel administrativo</p><h1 className="mt-1 break-words text-2xl font-semibold [overflow-wrap:anywhere]">{title}</h1></div>
            {backHref ? <Link href={backHref} className="inline-flex min-h-11 w-fit items-center gap-2 rounded-lg border border-white/25 px-4 text-sm font-semibold text-white transition hover:border-white/60 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"><ArrowLeft size={18} /> {backLabel}</Link> : null}
          </div>
        </div>
        <div className="mt-6 min-w-0">{children}</div>
      </div>
      <PushNotificationRuntime />
    </section>
  );
}
