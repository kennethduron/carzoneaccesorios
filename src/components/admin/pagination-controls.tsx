"use client";

import Link from "next/link";

type PaginationControlsProps = {
  basePath: string;
  page: number;
  pageSize: number;
  total: number;
  label: string;
  params?: Record<string, string | number | null | undefined>;
};

export function PaginationControls({ basePath, page, pageSize, total, label, params = {} }: PaginationControlsProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastItem = Math.min(page * pageSize, total);

  function buildHref(nextPage: number) {
    const search = new URLSearchParams();

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "" && value !== "all") {
        search.set(key, String(value));
      }
    });

    if (nextPage > 1) {
      search.set("page", String(nextPage));
    }

    const query = search.toString();
    return query ? `${basePath}?${query}` : basePath;
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-black/10 bg-white p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-black/60">
        Mostrando <span className="font-semibold text-[#1c1d1b]">{firstItem.toLocaleString("es-HN")}</span>-
        <span className="font-semibold text-[#1c1d1b]">{lastItem.toLocaleString("es-HN")}</span> de{" "}
        <span className="font-semibold text-[#1c1d1b]">{total.toLocaleString("es-HN")}</span> {label}.
      </p>
      <div className="flex items-center gap-2">
        <Link
          href={buildHref(page - 1)}
          aria-disabled={page <= 1}
          className={`rounded-md border border-black/10 px-4 py-2 font-medium ${
            page <= 1 ? "pointer-events-none bg-[#f7f7f2] text-black/35" : "bg-white text-[#1c1d1b] hover:bg-[#f7f7f2]"
          }`}
        >
          Anterior
        </Link>
        <span className="min-w-24 text-center text-black/55">
          {page} / {totalPages}
        </span>
        <Link
          href={buildHref(page + 1)}
          aria-disabled={page >= totalPages}
          className={`rounded-md border border-black/10 px-4 py-2 font-medium ${
            page >= totalPages ? "pointer-events-none bg-[#f7f7f2] text-black/35" : "bg-white text-[#1c1d1b] hover:bg-[#f7f7f2]"
          }`}
        >
          Siguiente
        </Link>
      </div>
    </div>
  );
}
