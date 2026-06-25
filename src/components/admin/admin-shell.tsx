import type { ReactNode } from "react";
import { PushNotificationRuntime } from "@/components/admin/push-notification-runtime";

type AdminShellProps = {
  title: string;
  children: ReactNode;
  variant?: "default" | "dashboard";
};

export function AdminShell({ title, children, variant = "default" }: AdminShellProps) {
  if (variant === "dashboard") {
    return (
      <section className="min-h-screen overflow-x-hidden bg-[#f4f4f5] text-[#080808]">
        {children}
        <PushNotificationRuntime />
      </section>
    );
  }

  return (
    <section className="min-h-screen overflow-x-hidden bg-[#f4f4f5] px-3 py-4 text-[#080808] sm:px-5 sm:py-6">
      <div className="mx-auto w-full max-w-7xl min-w-0">
        <div className="mb-4 rounded-lg bg-[#080808] px-4 py-4 text-white shadow-lg shadow-black/10 sm:mb-6 sm:px-5">
          <p className="text-xs font-semibold uppercase text-[#e4252c]">Panel administrativo</p>
          <h1 className="mt-1 break-words text-2xl font-semibold [overflow-wrap:anywhere]">{title}</h1>
        </div>
        <div className="mt-6 min-w-0">{children}</div>
      </div>
      <PushNotificationRuntime />
    </section>
  );
}
