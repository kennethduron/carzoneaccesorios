"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, History, PackagePlus, Save } from "lucide-react";
import { createInventoryMovementAction } from "@/app/admin/inventario/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type {
  InventoryMovementInput,
  InventoryMovementRow,
  InventoryMovementType,
  InventoryProductOption,
} from "@/types/inventory";
import { formatHnDateTime } from "@/utils/format";

type InventoryManagerProps = {
  products: InventoryProductOption[];
  movements: InventoryMovementRow[];
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

export function InventoryManager({ products, movements }: InventoryManagerProps) {
  const [movement, setMovement] = useState<InventoryMovementInput>(emptyMovement);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  const lowStockProducts = useMemo(
    () => products.filter((product) => product.available_stock <= product.min_stock),
    [products],
  );
  const outOfStockProducts = useMemo(
    () => products.filter((product) => product.available_stock <= 0),
    [products],
  );
  const totalStock = products.reduce((sum, product) => sum + product.stock, 0);
  const reservedStock = products.reduce((sum, product) => sum + product.reserved_stock, 0);

  function submitMovement() {
    startTransition(async () => {
      const result = await createInventoryMovementAction(movement);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Movimiento de inventario registrado correctamente.");
      } else {
        toast.error(result.message || "No se pudo registrar el movimiento de inventario.");
      }
      if (result.ok) {
        setMovement(emptyMovement);
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Productos controlados" value={products.length.toLocaleString("es-HN")} />
        <Metric label="Unidades en stock" value={totalStock.toLocaleString("es-HN")} />
        <Metric label="Unidades reservadas" value={reservedStock.toLocaleString("es-HN")} />
        <Metric label="Productos sin stock" value={outOfStockProducts.length.toLocaleString("es-HN")} />
      </div>

      <section className="grid gap-5 lg:grid-cols-[420px_1fr]">
        <div className="rounded-lg border border-black/10 bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <PackagePlus size={19} />
            <h2 className="font-semibold">Registrar movimiento</h2>
          </div>
          <div className="grid gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase text-black/50">Producto</span>
              <select
                value={movement.product_id}
                onChange={(event) => setMovement((current) => ({ ...current, product_id: event.target.value }))}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                <option value="">Seleccionar producto</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} - {product.name} ({product.available_stock} disponibles)
                  </option>
                ))}
              </select>
            </label>
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
                onChange={(event) =>
                  setMovement((current) => ({ ...current, quantity: Number(event.target.value) }))
                }
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

        <div className="rounded-lg border border-black/10 bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <AlertTriangle size={19} />
            <h2 className="font-semibold">Alertas de inventario</h2>
          </div>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Metric label="Bajo mínimo" value={lowStockProducts.length.toLocaleString("es-HN")} compact />
            <Metric label="Sin stock" value={outOfStockProducts.length.toLocaleString("es-HN")} compact />
            <Metric label="Reservas activas" value={reservedStock.toLocaleString("es-HN")} compact />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {lowStockProducts.length === 0 ? (
              <p className="text-sm text-black/55">
                Inventario sin alertas. Cuando un producto llegue al mínimo o se quede sin stock, aparecerá aquí.
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
        <div className="flex items-center gap-2 border-b border-black/10 p-5">
          <History size={19} />
          <h2 className="font-semibold">Historial</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Producto</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Cantidad</th>
                <th className="px-4 py-3">Antes</th>
                <th className="px-4 py-3">Después</th>
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
                  <td className="px-4 py-3">{item.notes ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
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


