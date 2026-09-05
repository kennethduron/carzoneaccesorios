"use client";
// Local-only HTTP fixture for the actual workspace; SQL certification covers
// the real server separately. No request from this fixture can confirm a sale.
import { useEffect, useState } from "react";
import { PosWorkspace } from "@/components/admin/pos-workspace";
import type { PosCustomerContext, PosDraftItem, PosSaleDraft } from "@/types/point-of-sale";
const id = "55000000-0000-4000-8000-000000000001";
const initialItem: PosDraftItem = {
  itemId: id, linePosition: 1, productId: id, productSalesVersion: 1, sku: "LOCAL-5500", internalCode: null,
  productName: "Producto local 5500", brand: "LOCAL", categoryName: null, imageUrl: null,
  pricingSource: "retail", baseUnitPrice: 5500, finalUnitPrice: 5500, priceOverridden: false,
  priceOverrideReason: null, quantity: 3, taxCategory: "standard", includedTaxRate: 0.15,
  lineMerchandiseGross: 16500, lineTaxableBase: 14347.83, lineTaxAmount: 2152.17, lineExemptAmount: 0,
  physicalStock: 100, reservedStock: 0, availableStock: 100, tracksInventory: true, hasActiveReservations: false,
  stockObservedAt: new Date().toISOString(), stockStatus: "available", validationStatus: "valid",
  costFloorValidated: true, costValidationVersion: 1, costValidatedAt: new Date().toISOString(),
};
const customer: PosCustomerContext = {
  customerId: id, displayName: "Cliente local", businessName: null, phone: "99999999", email: null, taxId: null,
  address: "Local", city: "Tegucigalpa", commercialNotes: null, customerType: "retail", wholesaleStatus: "none",
  pricingMode: "retail", pricingReason: "Local", commercialVersion: 1, hasPortalAccount: false, customerStatus: "active",
  credit: { accountExists: false, status: "not_enabled", enabled: false, creditLimit: 0, termsDays: 30, notes: null,
    openBalance: 0, availableCredit: 0, overdueBalance: 0, receivableCount: 0, canUseCredit: false, reason: "Local" },
  summary: { orderCount: 0, invoiceCount: 0, totalBilled: 0 },
};
export default function Certification() {
  const [ready, setReady] = useState(false);
  const [payload, setPayload] = useState("");
  useEffect(() => {
    if (!["localhost", "127.0.0.1"].includes(location.hostname)) throw new Error("Local only");
    const originalFetch = window.fetch;
    let draft: PosSaleDraft = {
      draftId: id, ownerId: id, customerId: id, customerCommercialVersion: 1, pricingMode: "retail", status: "active",
      version: 1, deliveryMode: "store_immediate", deliveryAddress: "Local", deliveryNotes: null, internalNotes: null,
      merchandiseGross: 16500, taxableGross: 16500, taxableBase: 14347.83, exemptGross: 0, taxAmount: 2152.17,
      shippingFee: 0, codFee: 0, additionalCharge: 0, additionalChargeDescription: null, otherCharge: 0, otherChargeDescription: null,
      grandTotal: 16500, calculationVersion: 2, currency: "HNL", validationStatus: "valid", validationMessages: [],
      expiresAt: "2099-01-01", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), items: [initialItem],
    };
    window.fetch = async (input, init) => {
      const path = String(input);
      const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (!path.startsWith("/api/admin/pos/")) return originalFetch(input, init);
      if (path.includes("/confirm")) { setPayload(`CONFIRM ${init?.body}`); return response({ code: "LOCAL_VALIDATION", message: "Respuesta de validacion local: sin venta creada." }, 422); }
      if (path.includes("/capabilities")) return response({ shippingFeeEnabled: true, codFeeEnabled: true, additionalChargeEnabled: true, externalChargeEnabled: true, otherChargeEnabled: true });
      if (path.includes("/customers/")) return response(customer);
      if (path.includes("/products/inventory")) return response({ snapshots: [initialItem] });
      if (path.includes("/drafts?")) return response({ drafts: [] });
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)); setPayload(`SAVE ${init.body}`);
        const items = body.items.map((line: { finalUnitPrice: number | null; quantity: number; priceOverrideReason: string | null }) => {
          const price = Math.round((line.finalUnitPrice ?? 5500) * 100) / 100;
          return { ...initialItem, finalUnitPrice: price, quantity: line.quantity, priceOverridden: price !== 5500, priceOverrideReason: line.priceOverrideReason };
        });
        const total = items.reduce((sum: number, line: PosDraftItem) => sum + line.quantity * line.finalUnitPrice, 0);
        draft = { ...draft, ...body, version: draft.version + 1, items, merchandiseGross: total, taxableGross: total,
          taxableBase: Math.round(total / 1.15 * 100) / 100, taxAmount: total - Math.round(total / 1.15 * 100) / 100, grandTotal: total };
      }
      return response(draft);
    };
    sessionStorage.setItem("car-zone-pos-stage4-draft-id", id);
    const readyTimer = window.setTimeout(() => setReady(true), 0);
    return () => { window.clearTimeout(readyTimer); window.fetch = originalFetch; sessionStorage.removeItem("car-zone-pos-stage4-draft-id"); };
  }, []);
  return <main className="p-3"><p>Certificacion local sin escrituras externas</p>{ready && <PosWorkspace operatorName="Propietario local" creditOverrideCapability={{ overrideAllowed: false, featureEnabled: false }} />}
    <pre data-testid="captured-payload" className="whitespace-pre-wrap break-all text-xs">{payload}</pre></main>;
}



