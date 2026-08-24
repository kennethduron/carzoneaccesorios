"use client";

import { useState } from "react";
import { OrderCommercialTerms } from "@/components/admin/order-commercial-terms";
import type { AdminOrderRow } from "@/types/orders";

const certificationOrder: AdminOrderRow = {
  id: "00000000-0000-4000-8000-000000000801",
  order_number: "CZ-LOCAL-COMMERCIAL-OVERLAP-001",
  source: "pos",
  channel: "Punto de venta",
  tracking_code: "TRK-CZ-LOCAL-COMMERCIAL-OVERLAP-001",
  tracking_status: "pending",
  public_tracking_enabled: false,
  customer_id: "00000000-0000-4000-8000-000000000802",
  customer_name: "Cliente sintético de certificación responsive",
  customer_phone: "99990000",
  customer_rtn: null,
  fiscal_customer_name: "Cliente sintético de certificación responsive",
  fiscal_customer_rtn: null,
  fiscal_customer_phone: "99990000",
  fiscal_customer_email: "certificacion@example.test",
  fiscal_customer_address: "Dirección sintética",
  email: "certificacion@example.test",
  phone: "99990000",
  delivery_address: "Boulevard sintético, edificio de nombre deliberadamente extenso, San Pedro Sula",
  delivery_country: "Honduras",
  delivery_country_code: "HN",
  delivery_department: "Cortés",
  delivery_city: "San Pedro Sula",
  payment_method: "cash",
  payment_timing: "on_delivery",
  price_mode: "retail",
  subtotal: 3_435_319.23,
  tax: 515_297.88,
  shipping_fee: 2_500,
  shipping_total: 2_500,
  cash_on_delivery_fee: 1_000,
  small_order_fee: 0,
  discount_total: 0,
  additional_fees: [],
  total: 3_954_117.11,
  status: "pending",
  order_reservation_status: "not_required",
  reservation_expires_at: null,
  reservation_review_required: false,
  reservation_review_detected_at: null,
  created_at: "2026-08-24T14:00:00.000Z",
  requested_invoice_date: "2026-08-24",
  shipping_fee_suggested: 120,
  commercial_terms_version: 7,
  delivery_mode: "external_company",
  external_delivery_provider: "Transportes Internacionales del Valle y Servicios Logísticos Especializados de Honduras",
  order_items: [
    {
      id: "00000000-0000-4000-8000-000000000811",
      product_id: "00000000-0000-4000-8000-000000000821",
      sku: "EXT-LONG-001",
      product_name: "Kit premium de iluminación automotriz para instalación profesional con arnés reforzado y controlador inteligente",
      quantity: 12,
      applied_price_mode: "retail",
      unit_price: 123_456.78,
      line_total: 1_481_481.36,
      retail_price_snapshot: 123_456.78,
      wholesale_price_snapshot: 118_000,
      unit_cost_snapshot: 98_765.43,
      total_cost_snapshot: 1_185_185.16,
      cost_source: "synthetic",
      cost_captured_at: "2026-08-24T14:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000812",
      product_id: "00000000-0000-4000-8000-000000000822",
      sku: "EXT-LONG-002",
      product_name: "Protector lateral universal extralargo con acabado negro satinado y accesorios completos de montaje",
      quantity: 25,
      applied_price_mode: "retail",
      unit_price: 98_765.43,
      line_total: 2_469_135.75,
      retail_price_snapshot: 98_765.43,
      wholesale_price_snapshot: 91_500,
      unit_cost_snapshot: 65_432.1,
      total_cost_snapshot: 1_635_802.5,
      cost_source: "synthetic",
      cost_captured_at: "2026-08-24T14:00:00.000Z",
    },
  ],
  payment_id: null,
  payment_status: "pending",
  bank_reference_number: null,
  transfer_receipt_url: null,
  transfer_receipt_public_id: null,
  order_internal_notes: [],
  invoice_id: null,
  invoice_number: null,
  invoice_issued_at: null,
  invoice_date: null,
  invoice_status: null,
  invoice_cancelled_at: null,
  invoice_cancellation_reason: null,
  fiscal_correction_history: [],
  receivable_id: null,
  receivable_status: null,
  receivable_due_date: null,
  receivable_balance_due: null,
  receivable_paid_at: null,
  receivable_payment_received_method: null,
  receivable_payment_received_reference: null,
  receivable_payment_recorded_by: null,
  accounting_traceability: null,
  price_review: {
    status: "none",
    reasons: [],
    invoiceConsistent: null,
    legitimateModeFallbackItemIds: [],
    adjustments: [],
  },
};

export function OrderCommercialTermsCertification() {
  const [dirty, setDirty] = useState(false);

  return (
    <main className="min-h-screen bg-[#f4f4f5] p-4 text-[#080808]" data-testid="commercial-overlap-certification">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/10 bg-white p-4">
        <div>
          <p className="text-xs font-semibold uppercase text-[#b91c25]">Fixture local · datos sintéticos</p>
          <h1 className="mt-1 text-xl font-semibold">Pedidos · términos comerciales</h1>
        </div>
        <output data-testid="commercial-dirty-state" className="rounded-full bg-[#f4f4f5] px-3 py-2 text-sm font-semibold">
          {dirty ? "dirty" : "clean"}
        </output>
      </div>

      <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(280px,310px)_minmax(0,1fr)] xl:grid-cols-[minmax(320px,360px)_minmax(0,1fr)]">
        <aside className="hidden min-w-0 rounded-xl border border-black/10 bg-white p-4 lg:block" aria-label="Navegador sintético de pedidos">
          <p className="font-semibold">Pedidos</p>
          <p className="mt-2 text-sm text-black/55">Panel maestro sintético para reproducir el ancho real del detalle.</p>
        </aside>
        <div className="min-w-0 rounded-xl border border-black/10 bg-white p-4" data-testid="commercial-detail-fixture">
          <OrderCommercialTerms
            order={certificationOrder}
            canEdit
            confirmationModalEnabled
            onDirtyChange={setDirty}
          />
        </div>
      </section>
    </main>
  );
}
