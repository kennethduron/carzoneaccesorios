import Link from "next/link";
import { BadgeDollarSign, ShoppingCart, TrendingUp } from "lucide-react";

export function CommercialNav({ canApprove = false }: { canApprove?: boolean }) {
  return <nav aria-label="Gestión comercial" className="mb-3 flex gap-2 overflow-x-auto rounded-xl border border-black/10 bg-white p-2 shadow-sm">
    <Link href="/admin/pos" className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-semibold hover:bg-red-50 hover:text-red-700"><ShoppingCart size={17} /> Punto de venta</Link>
    <Link href="/admin/mis-ventas" className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-semibold hover:bg-red-50 hover:text-red-700"><TrendingUp size={17} /> Mis ventas</Link>
    {canApprove ? <Link href="/admin/aprobaciones-precio" className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-semibold hover:bg-red-50 hover:text-red-700"><BadgeDollarSign size={17} /> Aprobaciones</Link> : null}
  </nav>;
}
