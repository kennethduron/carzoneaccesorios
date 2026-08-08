"use client";

import { useState } from "react";
import { CustomerContextPanel } from "@/components/admin/pos-customer-workspace";
import { PosCart } from "@/components/admin/pos-cart";
import { POS_SUMMARY_COLUMN_CLASS, POS_WORKSPACE_GRID_CLASS } from "@/components/admin/pos-layout";
import type { PosCustomerContext, PosDraftItem } from "@/types/point-of-sale";

const certificationCustomer: PosCustomerContext = {
  customerId: "00000000-0000-4000-8000-000000000001",
  displayName: "Ken Code",
  businessName: "Empresa Sintética de Accesorios Automotrices con Nombre Extenso",
  phone: "+504 2200-0000",
  email: "cliente.visual.con.correo.muy.extenso@empresa-ejemplo.test",
  taxId: "0801-0000-000000",
  address: "Dirección sintética local",
  city: "Tegucigalpa",
  commercialNotes: null,
  customerType: "wholesale",
  wholesaleStatus: "approved",
  pricingMode: "wholesale",
  pricingReason: "Cliente mayorista sintético aprobado y activo para certificación visual local.",
  commercialVersion: 1,
  hasPortalAccount: true,
  customerStatus: "active",
  credit: {
    accountExists: true,
    status: "active",
    enabled: true,
    creditLimit: 20000,
    termsDays: 30,
    notes: "Condiciones sintéticas para revisar contenido extenso.",
    openBalance: 1234.56,
    availableCredit: 18765.44,
    overdueBalance: 0,
    receivableCount: 2,
    canUseCredit: true,
    reason: "Crédito comercial activo. El disponible se verificará nuevamente al confirmar.",
  },
  summary: { orderCount: 12, invoiceCount: 9, totalBilled: 98765.43 },
};

function certificationItems(count: number): PosDraftItem[] {
  const now = "2026-08-08T12:00:00.000Z";
  return Array.from({ length: count }, (_, index) => ({
    productId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    productSalesVersion: 1,
    sku: `VIS-${String(index + 1).padStart(3, "0")}`,
    internalCode: `LOCAL-${index + 1}`,
    productName: `Producto sintético de certificación visual ${index + 1}`,
    brand: "Marca local",
    categoryName: "Accesorios",
    imageUrl: null,
    pricingSource: "wholesale",
    baseUnitPrice: 400 + index * 25,
    finalUnitPrice: 400 + index * 25,
    priceOverridden: false,
    priceOverrideReason: null,
    quantity: 1,
    taxCategory: "standard",
    includedTaxRate: 0.15,
    lineMerchandiseGross: 400 + index * 25,
    lineTaxableBase: 0,
    lineTaxAmount: 0,
    lineExemptAmount: 0,
    availableStock: 50,
    tracksInventory: true,
    stockObservedAt: now,
    stockStatus: "available",
    validationStatus: "valid",
    costFloorValidated: true,
    costValidationVersion: 1,
    costValidatedAt: now,
  }));
}

export function PosLayoutCertification({ itemCount }: { itemCount: number }) {
  const [items, setItems] = useState(() => certificationItems(itemCount));

  return (
    <div data-testid="pos-layout-certification" className={POS_WORKSPACE_GRID_CLASS}>
      <section className="min-w-0 rounded-xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
        <CustomerContextPanel context={certificationCustomer} message="" onEdit={() => undefined} onClear={() => undefined} />
      </section>
      <div className="min-w-0 space-y-4">
        <PosCart items={items} onChange={setItems} onClear={() => setItems([])} />
        <section className="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">Entrega y cargos</h2>
          <p className="mt-1 text-sm text-black/55">Bloque sintético sin persistencia para validar la continuidad del layout.</p>
        </section>
      </div>
      <div className={POS_SUMMARY_COLUMN_CLASS}>
        <section data-testid="pos-layout-summary" className="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">Resumen del borrador</h2>
          <p className="mt-2 text-sm text-black/55">Contenido sintético de certificación visual.</p>
        </section>
        <section className="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">Confirmar venta</h2>
          <button type="button" disabled className="mt-3 min-h-11 rounded-lg bg-[#e4252c] px-4 text-sm font-semibold text-white opacity-50">Confirmar venta</button>
        </section>
      </div>
    </div>
  );
}
