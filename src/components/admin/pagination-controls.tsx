"use client";

import Link from "next/link";

type PaginationControlsProps = {
  basePath: string;
  page: number;
  pageSize: number;
  total: number;
  label: string;
  params?: Record<string, string | number | null | undefined>;
  pageParam?: string;
  pageSizeParam?: number;
  pageHrefBuilder?: (page: number) => string;
};

export function PaginationControls({ basePath, page, pageSize, total, label, params = {}, pageParam = "page", pageSizeParam, pageHrefBuilder }: PaginationControlsProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastItem = Math.min(page * pageSize, total);

  function buildHref(nextPage: number) {
    if (pageHrefBuilder) return pageHrefBuilder(nextPage);

    const search = new URLSearchParams();

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "" && value !== "all") {
        search.set(key, String(value));
      }
    });

    if (pageSizeParam) {
      search.set("pageSize", String(pageSizeParam));
    }

    if (nextPage > 1) {
      search.set(pageParam, String(nextPage));
    }

    const query = search.toString();
    return query ? `${basePath}?${query}` : basePath;
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-black/10 bg-white p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-black/60">
        Mostrando <span className="font-semibold text-[#080808]">{firstItem.toLocaleString("es-HN")}</span>-
        <span className="font-semibold text-[#080808]">{lastItem.toLocaleString("es-HN")}</span> de{" "}
        <span className="font-semibold text-[#080808]">{total.toLocaleString("es-HN")}</span> {label}.
      </p>
      <div className="grid grid-cols-2 items-center gap-2 sm:flex">
        <Link
          href={buildHref(page - 1)}
          aria-disabled={page <= 1}
          className={`inline-flex min-h-11 items-center justify-center rounded-md border border-black/10 px-3 py-2 text-center font-medium sm:px-4 ${
            page <= 1 ? "pointer-events-none bg-[#f4f4f5] text-black/35" : "bg-white text-[#080808] hover:bg-[#f4f4f5]"
          }`}
        >
          Anterior
        </Link>
        <span className="order-first col-span-2 min-w-0 text-center text-black/55 sm:order-none sm:min-w-24">
          {page} / {totalPages}
        </span>
        <Link
          href={buildHref(page + 1)}
          aria-disabled={page >= totalPages}
          className={`inline-flex min-h-11 items-center justify-center rounded-md border border-black/10 px-3 py-2 text-center font-medium sm:px-4 ${
            page >= totalPages ? "pointer-events-none bg-[#f4f4f5] text-black/35" : "bg-white text-[#080808] hover:bg-[#f4f4f5]"
          }`}
        >
          Siguiente
        </Link>
      </div>
    </div>
  );
}


