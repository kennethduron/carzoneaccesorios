import type { ReactNode } from "react";

type AdminShellProps = {
  title: string;
  children: ReactNode;
};

export function AdminShell({ title, children }: AdminShellProps) {
  return (
    <section className="min-h-screen bg-[#f4f4f5] px-5 py-6 text-[#080808]">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 rounded-lg bg-[#080808] px-5 py-4 text-white shadow-lg shadow-black/10">
          <p className="text-xs font-semibold uppercase text-[#e4252c]">Panel administrativo</p>
          <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </section>
  );
}

