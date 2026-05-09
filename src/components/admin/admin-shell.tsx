import type { ReactNode } from "react";

type AdminShellProps = {
  title: string;
  children: ReactNode;
};

export function AdminShell({ title, children }: AdminShellProps) {
  return (
    <section className="min-h-screen bg-[#f7f7f2] px-5 py-6 text-[#1c1d1b]">
      <div className="mx-auto max-w-7xl">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <div className="mt-6">{children}</div>
      </div>
    </section>
  );
}
