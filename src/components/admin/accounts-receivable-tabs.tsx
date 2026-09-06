import Link from "next/link";
import { BarChart3, FileText, UploadCloud } from "lucide-react";

export type ReceivableSection = "summary" | "accounts" | "import";

export function AccountsReceivableTabs({ section, attentionCount }: { section: ReceivableSection; attentionCount: number }) {
  const tabs = [
    ["summary", "Resumen", BarChart3], ["accounts", "Cuentas", FileText], ["import", "Importación histórica", UploadCloud],
  ] as const;
  return <nav aria-label="Secciones de cuentas por cobrar" className="mb-3 grid grid-cols-3 overflow-hidden rounded-xl border border-black/10 bg-white">
    {tabs.map(([value, label, Icon]) => <Link key={value} href={`/admin/cuentas-por-cobrar?section=${value}`} aria-current={section === value ? "page" : undefined} className={`flex min-h-11 min-w-0 items-center justify-center gap-2 border-r border-black/10 px-2 text-sm font-medium last:border-r-0 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-[#e30613] ${section === value ? "bg-red-50 text-[#e30613]" : "text-black/65 hover:bg-black/[.03]"}`}><Icon size={18}/><span className="truncate">{label}</span>{value === "import" && attentionCount > 0 ? <span aria-label={`${attentionCount} filas requieren atención`} className="rounded-full bg-[#e30613] px-2 py-0.5 text-xs font-bold text-white">{attentionCount}</span> : null}</Link>)}
  </nav>;
}
