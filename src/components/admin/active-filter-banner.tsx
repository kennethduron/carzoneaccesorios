import Link from "next/link";
import { X } from "lucide-react";

type ActiveFilterBannerProps = {
  label: string;
  clearHref: string;
};

export function ActiveFilterBanner({ label, clearHref }: ActiveFilterBannerProps) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[#e4252c]/25 bg-[#fff1f2] p-4 text-sm text-[#7f1d1d] sm:flex-row sm:items-center sm:justify-between">
      <p>
        <span className="font-semibold">Filtro activo:</span> {label}
      </p>
      <Link
        href={clearHref}
        className="inline-flex w-fit items-center gap-2 rounded-md border border-[#e4252c]/25 bg-white px-3 py-2 font-semibold text-[#7f1d1d] transition-colors hover:bg-[#fff7f7]"
      >
        <X size={16} />
        Limpiar filtro
      </Link>
    </section>
  );
}
