import Link from "next/link";
import { BadgeDollarSign, CircleDollarSign, Home, Package, ShoppingCart, TrendingUp, Users } from "lucide-react";

const itemClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition hover:bg-red-50 hover:text-red-700 sm:justify-start";

export function CommercialNav({ canApprove = false, sellerMode = false }: { canApprove?: boolean; sellerMode?: boolean }) {
  return <nav aria-label="Gestion comercial" className="mb-3 grid grid-cols-2 gap-1 rounded-xl border border-black/10 bg-white p-2 shadow-sm sm:flex sm:flex-wrap">
    {sellerMode ? <Link href="/admin" className={itemClass}><Home size={17} /> Inicio</Link> : null}
    <Link href="/admin/pos" className={itemClass}><ShoppingCart size={17} /> Punto de venta</Link>
    <Link href="/admin/mis-ventas" className={itemClass}><TrendingUp size={17} /> Mis ventas</Link>
    {sellerMode ? <>
      <Link href="/admin/clientes" className={itemClass}><Users size={17}/> Clientes</Link>
      <Link href="/admin/productos" className={itemClass}><Package size={17}/> Productos</Link>
      <Link href="/admin/mi-comision" className={itemClass}><CircleDollarSign size={17}/> Mi comision</Link>
    </> : null}
    {canApprove ? <Link href="/admin/aprobaciones-precio" className={itemClass}><BadgeDollarSign size={17} /> Aprobaciones</Link> : null}
  </nav>;
}
