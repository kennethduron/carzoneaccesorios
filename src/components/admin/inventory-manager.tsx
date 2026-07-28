"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, History, PackagePlus, Save } from "lucide-react";
import { createInventoryMovementAction } from "@/app/admin/inventario/actions";
import { ActiveFilterBanner } from "@/components/admin/active-filter-banner";
import { InventoryProductCombobox } from "@/components/admin/inventory-product-combobox";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AdminInventorySummary } from "@/services/supabase/admin-inventory.service";
import type {
  InventoryMovementInput,
  InventoryMovementRow,
  InventoryMovementType,
  InventoryProductOption,
} from "@/types/inventory";
import type { InventoryProductSearchResult } from "@/types/admin-search";
import { formatHnDateTime } from "@/utils/format";

type InventoryManagerProps = {
  products: InventoryProductOption[];
  movements: InventoryMovementRow[];
  summary: AdminInventorySummary;
  productQuery: string;
  activeFilter?: { id: string; label: string } | null;
  canManageInventory: boolean;
};

const movementLabels: Record<InventoryMovementType, string> = {
  purchase: "Entrada",
  return: "Devolución",
  sale: "Salida",
  adjustment: "Ajuste",
};

const movementHelp: Record<InventoryMovementType, string> = {
  purchase: "Agrega stock recibido.",
  return: "Registra productos devueltos al inventario.",
  sale: "Registra salida manual de inventario.",
  adjustment: "Corrige inventario físico después de revisión.",
};

const emptyMovement: InventoryMovementInput = {
  product_id: "",
  movement_type: "purchase",
  quantity: 1,
  notes: "",
};

function inventoryProductState(product: InventoryProductOption) {
  if (product.auto_disabled_by_stock) {
    return "Inactivo por inventario";
  }

  if (product.active === false) {
    return "Inactivo manual";
  }

  return "Activo";
}

export function InventoryManager({
  products,
  movements,
  summary,
  productQuery,
  activeFilter = null,
  canManageInventory,
}: InventoryManagerProps) {
  const [movement, setMovement] = useState<InventoryMovementInput>(emptyMovement);
  const [selectedMovementProduct, setSelectedMovementProduct] = useState<InventoryProductSearchResult | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  const lowStockProducts = useMemo(() => products.filter((product) => product.available_stock <= product.min_stock).slice(0, 24), [products]);

  function submitMovement() {
    startTransition(async () => {
      const result = await createInventoryMovementAction(movement);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Movimiento de inventario registrado correctamente.");
        setMovement(emptyMovement);
        setSelectedMovementProduct(null);
      } else {
        toast.error(result.message || "No se pudo registrar el movimiento de inventario.");
      }
    });
  }

  return (
    <div className="space-y-5">
      {activeFilter ? <ActiveFilterBanner label={activeFilter.label} clearHref="/admin/inventario" /> : null}

      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Productos encontrados" value={summary.productsTotal.toLocaleString("es-HN")} />
        <Metric
          label={canManageInventory ? "Bajo mínimo" : "Bajo mínimo"}
          value={summary.lowStockProducts.toLocaleString("es-HN")}
        />
        <Metric label="Reservas activas" value={summary.activeReservations.toLocaleString("es-HN")} />
        <Metric label="Productos sin stock" value={summary.outOfStockProducts.toLocaleString("es-HN")} />
      </div>

      {!canManageInventory ? (
        <>
          <p className="rounded-lg border border-[#2563eb]/20 bg-[#eff6ff] px-4 py-3 text-sm text-[#1e40af]" role="status">
            Acceso de consulta. Las entradas y cambios de inventario se registran mediante Compras o por usuarios autorizados.
          </p>
          <InventorySearchForm productQuery={productQuery} activeFilter={activeFilter} />
        </>
      ) : null}

      <section className={canManageInventory ? "grid gap-5 lg:grid-cols-[420px_1fr]" : "block"}>
        {canManageInventory ? (
          <div className="rounded-lg border border-black/10 bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <PackagePlus size={19} />
            <h2 className="font-semibold">Registrar movimiento</h2>
          </div>
          <div className="grid gap-3">
            <InventorySearchForm productQuery={productQuery} activeFilter={activeFilter} managementMode />

            <InventoryProductCombobox
              value={movement.product_id}
              selectedOption={selectedMovementProduct}
              disabled={isPending}
              onChange={(product) => {
                setSelectedMovementProduct(product);
                setMovement((current) => ({ ...current, product_id: product?.id ?? "" }));
              }}
            />
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase text-black/50">Tipo</span>
              <select
                value={movement.movement_type}
                onChange={(event) =>
                  setMovement((current) => ({
                    ...current,
                    movement_type: event.target.value as InventoryMovementType,
                  }))
                }
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                {Object.entries(movementLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-2 rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
              {Object.entries(movementHelp).map(([type, help]) => (
                <p key={type}>
                  <span className="font-semibold text-black">{movementLabels[type as InventoryMovementType]}:</span> {help}
                </p>
              ))}
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase text-black/50">Cantidad</span>
              <Input
                type="number"
                value={movement.quantity}
                onChange={(event) => setMovement((current) => ({ ...current, quantity: Number(event.target.value) }))}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase text-black/50">Notas</span>
              <textarea
                value={movement.notes}
                onChange={(event) => setMovement((current) => ({ ...current, notes: event.target.value }))}
                className="min-h-24 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
              />
            </label>
            <Button onClick={submitMovement} disabled={isPending} variant="dark" className="py-3">
              <Save size={17} />
              {isPending ? "Guardando..." : "Guardar movimiento"}
            </Button>
            {message ? (
              <p className={`rounded-md p-3 text-sm ${message.startsWith("Solo hay") ? "bg-[#fff0ea] text-[#9b341b]" : "bg-[#fff1f2] text-[#b91c25]"}`}>
                {message}
              </p>
            ) : null}
          </div>
          </div>
        ) : null}

        <div className="rounded-lg border border-black/10 bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <AlertTriangle size={19} />
            <h2 className="font-semibold">Alertas de inventario</h2>
          </div>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Metric label="Bajo mínimo" value={summary.lowStockProducts.toLocaleString("es-HN")} compact />
            <Metric label="Sin stock" value={summary.outOfStockProducts.toLocaleString("es-HN")} compact />
            <Metric label="Reservas activas" value={summary.activeReservations.toLocaleString("es-HN")} compact />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {lowStockProducts.length === 0 ? (
              <p className="text-sm text-black/55">
                Inventario sin alertas en las opciones cargadas. Usa búsqueda si quieres revisar un producto específico.
              </p>
            ) : (
              lowStockProducts.map((product) => (
                <div key={product.id} className="rounded-md bg-[#fff0ea] p-3 text-sm">
                  <p className="font-semibold text-[#9b341b]">{product.name}</p>
                  <p className="text-black/60">
                    Disponible {product.available_stock} / reservado {product.reserved_stock} / mínimo {product.min_stock}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
        <div className="border-b border-black/10 p-5">
          <h2 className="font-semibold">Stock por producto</h2>
          <p className="mt-1 text-sm text-black/55">
            Stock total, unidades reservadas por checkout y disponibilidad real para nuevas compras.
          </p>
        </div>
        <div className="grid gap-3 p-3 md:hidden">
          {products.length === 0 ? (
            <p className="rounded-md bg-[#f4f4f5] p-4 text-sm text-black/50">No hay productos cargados con ese filtro.</p>
          ) : (
            products.map((product) => (
              <article key={product.id} className="rounded-md border border-black/10 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words font-semibold [overflow-wrap:anywhere]">{product.name}</h3>
                    <p className="mt-1 break-words text-xs text-black/45 [overflow-wrap:anywhere]">{product.sku}</p>
                    <p className="mt-1 text-xs font-medium text-black/55">{inventoryProductState(product)}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                      product.available_stock <= 0
                        ? "bg-[#fdecec] text-[#a33a2d]"
                        : product.available_stock <= product.min_stock
                          ? "bg-[#fff4e5] text-[#9b5b00]"
                          : "bg-[#edf7ed] text-[#2f6f3e]"
                    }`}
                  >
                    {product.available_stock <= 0 ? "Sin stock" : product.available_stock <= product.min_stock ? "Bajo stock" : "Disponible"}
                  </span>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Stock</dt>
                    <dd className="mt-1 font-semibold">{product.stock}</dd>
                  </div>
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Reservado</dt>
                    <dd className="mt-1 font-semibold">{product.reserved_stock}</dd>
                  </div>
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Disponible</dt>
                    <dd className={`mt-1 font-semibold ${product.available_stock <= 0 ? "text-[#b91c25]" : "text-[#166534]"}`}>
                      {product.available_stock}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-black/50">Stock minimo: {product.min_stock}</p>
              </article>
            ))
          )}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">Producto</th>
                <th className="px-4 py-3">Stock total</th>
                <th className="px-4 py-3">Reservado</th>
                <th className="px-4 py-3">Disponible</th>
                <th className="px-4 py-3">Mínimo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {products.map((product) => (
                <tr key={product.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium">{product.name}</p>
                    <p className="text-xs text-black/45">{product.sku}</p>
                    <p className="text-xs text-black/55">{inventoryProductState(product)}</p>
                  </td>
                  <td className="px-4 py-3 font-semibold">{product.stock}</td>
                  <td className="px-4 py-3">{product.reserved_stock}</td>
                  <td className={`px-4 py-3 font-semibold ${product.available_stock <= 0 ? "text-[#b91c25]" : "text-[#166534]"}`}>
                    {product.available_stock}
                  </td>
                  <td className="px-4 py-3">{product.min_stock}</td>
                </tr>
              ))}
              {products.length === 0 ? (
                <tr>
                  <td className="px-4 py-5 text-black/50" colSpan={5}>
                    No hay productos cargados con ese filtro.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
        <div className="flex flex-col gap-3 border-b border-black/10 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <History size={19} />
            <h2 className="font-semibold">Historial</h2>
          </div>
          <p className="text-sm text-black/55">
            {summary.movementsTotal.toLocaleString("es-HN")} movimientos registrados
          </p>
        </div>
        <div className="grid gap-3 p-3 md:hidden">
          {movements.length === 0 ? (
            <p className="rounded-md bg-[#f4f4f5] p-4 text-sm text-black/50">Sin movimientos registrados todavia.</p>
          ) : (
            movements.map((item) => (
              <article key={item.id} className="rounded-md border border-black/10 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-black/50">{formatHnDateTime(item.created_at)}</p>
                    <h3 className="mt-1 break-words font-semibold [overflow-wrap:anywhere]">{item.product_name ?? "Producto"}</h3>
                    <p className="mt-1 break-words text-xs text-black/45 [overflow-wrap:anywhere]">{item.product_sku}</p>
                  </div>
                  <span className="shrink-0 rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-semibold">{movementLabels[item.movement_type]}</span>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Cantidad</dt>
                    <dd className="mt-1 font-semibold">{item.quantity}</dd>
                  </div>
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Antes</dt>
                    <dd className="mt-1 font-semibold">{item.stock_before}</dd>
                  </div>
                  <div className="rounded-md bg-[#f8fafc] p-2">
                    <dt className="text-xs uppercase text-black/45">Despues</dt>
                    <dd className="mt-1 font-semibold">{item.stock_after}</dd>
                  </div>
                </dl>
                <p className="mt-3 break-words text-sm text-black/60 [overflow-wrap:anywhere]">
                  {item.notes ?? item.reference_type ?? "Sin motivo registrado"}
                </p>
              </article>
            ))
          )}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Producto</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Cantidad</th>
                <th className="px-4 py-3">Antes</th>
                <th className="px-4 py-3">Después</th>
                <th className="px-4 py-3">Referencia</th>
                <th className="px-4 py-3">Notas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {movements.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3">{formatHnDateTime(item.created_at)}</td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{item.product_name ?? "Producto"}</p>
                    <p className="text-xs text-black/45">{item.product_sku}</p>
                  </td>
                  <td className="px-4 py-3">{movementLabels[item.movement_type]}</td>
                  <td className="px-4 py-3 font-semibold">{item.quantity}</td>
                  <td className="px-4 py-3">{item.stock_before}</td>
                  <td className="px-4 py-3">{item.stock_after}</td>
                  <td className="px-4 py-3">
                    <p>{item.reference_type ?? "-"}</p>
                    {item.reference_id ? <p className="text-xs text-black/45">{item.reference_id}</p> : null}
                  </td>
                  <td className="px-4 py-3">{item.notes ?? "-"}</td>
                </tr>
              ))}
              {movements.length === 0 ? (
                <tr>
                  <td className="px-4 py-5 text-black/50" colSpan={8}>
                    Sin movimientos registrados todavía.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="border-t border-black/10 p-4">
          <PaginationControls
            basePath="/admin/inventario"
            page={summary.movementPage}
            pageSize={summary.movementPageSize}
            total={summary.movementsTotal}
            label="movimientos"
            params={{ q: productQuery, filter: activeFilter?.id }}
            pageParam="mov_page"
          />
        </div>
      </section>
    </div>
  );
}

function InventorySearchForm({
  productQuery,
  activeFilter,
  managementMode = false,
}: {
  productQuery: string;
  activeFilter: { id: string; label: string } | null;
  managementMode?: boolean;
}) {
  return (
    <form action="/admin/inventario" className="grid gap-2 rounded-md border border-black/10 bg-[#f4f4f5] p-3">
      {activeFilter ? <input type="hidden" name="filter" value={activeFilter.id} /> : null}
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase text-black/50">Buscar producto</span>
        <Input name="q" defaultValue={productQuery} placeholder="SKU, código, nombre o marca" />
      </label>
      <Button type="submit" variant="ghost">
        Buscar inventario
      </Button>
      {managementMode ? <p className="text-xs text-black/50">El selector consulta el catálogo autorizado en páginas de 25 resultados.</p> : null}
    </form>
  );
}

function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className={`mt-1 font-semibold ${compact ? "text-xl" : "text-2xl"}`}>{value}</p>
    </div>
  );
}
