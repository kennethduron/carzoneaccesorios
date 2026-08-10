"use client";

import { useMemo, useRef, useState } from "react";
import { PlusCircle, Search } from "lucide-react";
import { CustomerContextPanel } from "@/components/admin/pos-customer-workspace";
import { PosCart } from "@/components/admin/pos-cart";
import { PosConfirmationPanel } from "@/components/admin/pos-confirmation-panel";
import { PosDeliveryFields, type PosDeliveryState } from "@/components/admin/pos-delivery-fields";
import { PosDraftSummary } from "@/components/admin/pos-draft-summary";
import { POS_OPERATIONAL_COLUMN_CLASS, POS_PRODUCT_COLUMN_CLASS, POS_SUMMARY_COLUMN_CLASS, POS_WORKSPACE_GRID_CLASS } from "@/components/admin/pos-layout";
import { PosMobileTotalBar } from "@/components/admin/pos-mobile-total-bar";
import { PosProductReservationsDialog } from "@/components/admin/pos-product-reservations-dialog";
import { resolvePosCustomerSelectionDeliveryAddress } from "@/lib/pos/customer-delivery-address";
import type { PosChargeCapabilities, PosCustomerContext, PosDraftItem, PosSaleDraft } from "@/types/point-of-sale";

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
    accountExists: true, status: "active", enabled: true, creditLimit: 20000, termsDays: 30,
    notes: "Condiciones sintéticas para revisar contenido extenso.", openBalance: 1234.56,
    availableCredit: 18765.44, overdueBalance: 0, receivableCount: 2, canUseCredit: true,
    reason: "Crédito comercial activo. El disponible se verificará nuevamente al confirmar.",
  },
  summary: { orderCount: 12, invoiceCount: 9, totalBilled: 98765.43 },
};

const overdueCertificationCustomer: PosCustomerContext = {
  ...certificationCustomer,
  credit: {
    ...certificationCustomer.credit,
    status: "on_hold",
    openBalance: 1600,
    availableCredit: 18400,
    overdueBalance: 1600,
    receivableCount: 1,
    canUseCredit: false,
    reason: "Existe saldo vencido: el crédito está en espera.",
  },
};

const capabilities: PosChargeCapabilities = {
  shippingFeeEnabled: true, codFeeEnabled: true, additionalChargeEnabled: true,
  externalChargeEnabled: true, otherChargeEnabled: true, disabledReason: "",
};

const certificationCityOnlyCustomer = {
  customerId: "00000000-0000-4000-8000-000000000002",
  address: null,
  city: "La Ceiba",
};

const certificationEmptyCustomer = {
  customerId: "00000000-0000-4000-8000-000000000003",
  address: null,
  city: null,
};

const initialDelivery: PosDeliveryState = {
  mode: "home_delivery", address: "Dirección sintética local", notes: "", internalNotes: "",
  shippingFee: "60.00", codFee: "0.00", additionalCharge: "0.00",
  additionalChargeDescription: "", otherCharge: "0.00", otherChargeDescription: "",
};

function certificationItems(count: number): PosDraftItem[] {
  const now = "2026-08-08T12:00:00.000Z";
  return Array.from({ length: count }, (_, index) => ({
    productId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    productSalesVersion: 1, sku: `VIS-${String(index + 1).padStart(3, "0")}`, internalCode: `LOCAL-${index + 1}`,
    productName: `Producto sintético de certificación visual ${index + 1}`, brand: "Marca local", categoryName: "Accesorios",
    imageUrl: null, pricingSource: "wholesale", baseUnitPrice: 400 + index * 25, finalUnitPrice: 400 + index * 25,
    priceOverridden: false, priceOverrideReason: null, quantity: 1, taxCategory: "standard", includedTaxRate: 0.15,
    lineMerchandiseGross: 400 + index * 25, lineTaxableBase: 0, lineTaxAmount: 0, lineExemptAmount: 0,
    physicalStock: index === 0 ? 5 : 50,
    reservedStock: index === 0 ? 3 : 0,
    availableStock: index === 0 ? 2 : 50,
    tracksInventory: true,
    hasActiveReservations: index === 0,
    stockObservedAt: now, stockStatus: "available", validationStatus: "valid",
    costFloorValidated: true, costValidationVersion: 1, costValidatedAt: now,
  }));
}

export function PosLayoutCertification({ itemCount }: { itemCount: number }) {
  const [items, setItems] = useState(() => certificationItems(itemCount));
  const [delivery, setDelivery] = useState(initialDelivery);
  const [selectedCustomerId, setSelectedCustomerId] = useState(certificationCustomer.customerId);
  const [reservationItem, setReservationItem] = useState<PosDraftItem | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const merchandise = items.reduce((sum, item) => sum + item.quantity * item.finalUnitPrice, 0);
  const taxableBase = Math.round((merchandise / 1.15) * 100) / 100;
  const tax = Math.round((merchandise - taxableBase) * 100) / 100;
  const total = merchandise + Number(delivery.shippingFee || 0) + Number(delivery.codFee || 0) + Number(delivery.additionalCharge || 0) + Number(delivery.otherCharge || 0);
  const draft = useMemo<PosSaleDraft>(() => ({
    draftId: "00000000-0000-4000-8000-000000000010", ownerId: "00000000-0000-4000-8000-000000000011",
    customerId: certificationCustomer.customerId, customerCommercialVersion: 1, pricingMode: "wholesale", status: "active", version: 1,
    deliveryMode: delivery.mode, deliveryAddress: delivery.address, deliveryNotes: delivery.notes, internalNotes: delivery.internalNotes,
    merchandiseGross: merchandise, taxableGross: merchandise, taxableBase, exemptGross: 0, taxAmount: tax,
    shippingFee: Number(delivery.shippingFee || 0), codFee: Number(delivery.codFee || 0),
    additionalCharge: Number(delivery.additionalCharge || 0), additionalChargeDescription: delivery.additionalChargeDescription || null,
    otherCharge: Number(delivery.otherCharge || 0), otherChargeDescription: delivery.otherChargeDescription || null,
    grandTotal: total, calculationVersion: 2, currency: "HNL", validationStatus: "valid", validationMessages: [],
    expiresAt: "2026-08-09T12:00:00.000Z", createdAt: "2026-08-08T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z", items,
  }), [delivery, items, merchandise, taxableBase, tax, total]);

  function selectCustomerLocation(nextCustomer: { customerId: string; address: string | null; city: string | null }) {
    setDelivery((current) => ({
      ...current,
      address: resolvePosCustomerSelectionDeliveryAddress({
        currentAddress: current.address,
        currentCustomerId: selectedCustomerId,
        nextCustomer,
        hasDraft: false,
      }),
    }));
    setSelectedCustomerId(nextCustomer.customerId);
  }

  return <div className="space-y-3 pb-24 min-[800px]:pb-0">
    <section data-testid="pos-sale-toolbar" className="rounded-xl border border-black/10 bg-white p-3 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-red-50 text-[#e4252c]"><PlusCircle size={20} /></span><div><h2 className="font-semibold text-[#e4252c]">Nueva venta</h2><p className="text-sm text-black/55">Agregue productos, revise los totales y seleccione el método de pago.</p></div></div><span className="inline-flex min-h-11 items-center rounded-lg bg-slate-100 px-3 text-sm font-semibold text-slate-700">Sin cambios</span></div></section>
    <div data-testid="pos-layout-certification" className={POS_WORKSPACE_GRID_CLASS}>
      <div className={POS_OPERATIONAL_COLUMN_CLASS}>
        <section className="min-w-0 rounded-xl border border-black/10 bg-white p-3 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-semibold">Cliente</h2><button type="button" className="min-h-11 rounded-lg border border-red-200 px-3 text-sm font-semibold text-red-700">Nuevo cliente</button></div>
          <div className="relative mb-3"><Search className="pointer-events-none absolute left-3 top-3 text-black/40" size={18} /><input aria-label="Buscar cliente" placeholder="Buscar cliente" className="min-h-11 w-full rounded-lg border border-black/15 pl-10 pr-3" /></div>
          <div data-testid="pos-address-prefill-controls" className="mb-3 flex flex-wrap gap-2">
            <button type="button" data-testid="select-customer-address" onClick={() => selectCustomerLocation(certificationCustomer)} className="min-h-11 rounded-lg border border-black/15 px-3 text-xs font-semibold">Cliente con dirección</button>
            <button type="button" data-testid="select-customer-city" onClick={() => selectCustomerLocation(certificationCityOnlyCustomer)} className="min-h-11 rounded-lg border border-black/15 px-3 text-xs font-semibold">Cliente solo ciudad</button>
            <button type="button" data-testid="select-customer-empty" onClick={() => selectCustomerLocation(certificationEmptyCustomer)} className="min-h-11 rounded-lg border border-black/15 px-3 text-xs font-semibold">Cliente sin ubicación</button>
          </div>
          <CustomerContextPanel context={certificationCustomer} message="" onEdit={() => undefined} onClear={() => undefined} />
        </section>
        <div className={POS_PRODUCT_COLUMN_CLASS}>
          <section className="rounded-xl border border-black/10 bg-white p-3 shadow-sm"><div className="flex items-center justify-between"><h2 className="font-semibold">Productos</h2><span className="text-xs font-semibold text-blue-700">Precios actualizados</span></div><div className="relative mt-2"><Search className="pointer-events-none absolute left-3 top-3 text-black/40" size={18} /><input aria-label="Buscar y agregar productos" placeholder="Buscar y agregar productos" className="min-h-11 w-full rounded-lg border border-black/15 pl-10 pr-3" /></div></section>
          <PosCart items={items} refreshingInventory={false} onChange={setItems} onClear={() => setItems([])} onRefreshInventory={() => undefined} onViewReservations={setReservationItem} />
          <PosDeliveryFields value={delivery} capabilities={capabilities} onChange={setDelivery} />
        </div>
      </div>
      <div id="pos-sale-summary" ref={summaryRef} className={POS_SUMMARY_COLUMN_CLASS}>
        <PosDraftSummary draft={draft} pending={false} merchandiseGross={merchandise} taxableGross={merchandise} taxableBase={taxableBase} taxAmount={tax} exemptGross={0} shippingFee={draft.shippingFee} codFee={draft.codFee} additionalCharge={draft.additionalCharge} additionalChargeDescription={draft.additionalChargeDescription ?? ""} otherCharge={draft.otherCharge} otherChargeDescription={draft.otherChargeDescription ?? ""} total={total} disabled onSave={() => undefined} />
        <PosConfirmationPanel draft={draft} customer={overdueCertificationCustomer} disabled={false} onConfirmed={() => undefined} onInventoryConflict={async () => []} onViewReservations={() => undefined} onNewSale={() => undefined} operatorName="Operador local" creditOverrideCapability={{ featureEnabled: true, overrideAllowed: true }} />
      </div>
    </div>
    <PosMobileTotalBar unitCount={items.reduce((sum, item) => sum + item.quantity, 0)} total={total} onReview={() => summaryRef.current?.scrollIntoView({ block: "start" })} />
    {reservationItem ? <PosProductReservationsDialog productName={reservationItem.productName} snapshot={{
      productId: reservationItem.productId,
      tracksInventory: reservationItem.tracksInventory,
      physicalStock: reservationItem.physicalStock,
      reservedStock: reservationItem.reservedStock,
      availableStock: reservationItem.availableStock,
      hasActiveReservations: reservationItem.hasActiveReservations,
      stockObservedAt: reservationItem.stockObservedAt,
    }} onClose={() => setReservationItem(null)} /> : null}
  </div>;
}
