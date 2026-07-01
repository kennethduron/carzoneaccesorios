"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseAdminClient } from "@/lib/supabase";
import type { PurchaseStatus } from "@/types/purchases";

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

type PurchaseItemInput = {
  id?: string;
  product_id?: string | null;
  description: string;
  quantity: number | string;
  unit_cost: number | string;
  tax_amount?: number | string | null;
  discount_amount?: number | string | null;
};

export type PurchaseFormInput = {
  id?: string;
  supplier_id: string;
  purchase_number: string;
  purchase_date: string;
  shipping_amount?: number | string | null;
  currency?: string | null;
  notes?: string | null;
  items: PurchaseItemInput[];
};

function cleanText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function toMoney(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : NaN;
}

function purchaseErrorMessage(message: string) {
  if (message.includes("purchases_purchase_number_key")) {
    return "Ya existe una compra con ese numero.";
  }

  return "No se pudo guardar la compra.";
}

function buildPurchaseTotals(items: PurchaseItemInput[], shippingValue: unknown) {
  const normalizedItems = items.map((item) => {
    const description = cleanText(item.description);
    const quantity = toMoney(item.quantity);
    const unitCost = toMoney(item.unit_cost);
    const taxAmount = toMoney(item.tax_amount ?? 0);
    const discountAmount = toMoney(item.discount_amount ?? 0);

    if (!description) {
      throw new Error("Cada linea necesita descripcion.");
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("La cantidad de cada linea debe ser mayor que cero.");
    }

    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new Error("El costo unitario no puede ser negativo.");
    }

    if (!Number.isFinite(taxAmount) || taxAmount < 0 || !Number.isFinite(discountAmount) || discountAmount < 0) {
      throw new Error("Impuestos y descuentos no pueden ser negativos.");
    }

    const lineSubtotal = Math.round(quantity * unitCost * 100) / 100;
    const totalCost = Math.max(Math.round((lineSubtotal + taxAmount - discountAmount) * 100) / 100, 0);

    return {
      id: cleanText(item.id),
      product_id: cleanText(item.product_id),
      description,
      quantity,
      unit_cost: unitCost,
      tax_amount: taxAmount,
      discount_amount: discountAmount,
      total_cost: totalCost,
    };
  });

  const shippingAmount = toMoney(shippingValue ?? 0);
  if (!Number.isFinite(shippingAmount) || shippingAmount < 0) {
    throw new Error("El envio no puede ser negativo.");
  }

  const subtotal = Math.round(normalizedItems.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0) * 100) / 100;
  const taxAmount = Math.round(normalizedItems.reduce((sum, item) => sum + item.tax_amount, 0) * 100) / 100;
  const discountAmount = Math.round(normalizedItems.reduce((sum, item) => sum + item.discount_amount, 0) * 100) / 100;
  const total = Math.max(Math.round((subtotal + taxAmount + shippingAmount - discountAmount) * 100) / 100, 0);

  return { normalizedItems, subtotal, taxAmount, discountAmount, shippingAmount, total };
}

export async function savePurchaseAction(input: PurchaseFormInput): Promise<ActionResult> {
  const profile = await requirePermission("purchases:manage");
  const supplierId = cleanText(input.supplier_id);
  const purchaseNumber = cleanText(input.purchase_number);
  const purchaseDate = cleanText(input.purchase_date);
  const currency = cleanText(input.currency) ?? "HNL";

  if (!supplierId) return { ok: false, message: "Selecciona un proveedor." };
  if (!purchaseNumber) return { ok: false, message: "El numero de compra es obligatorio." };
  if (!purchaseDate) return { ok: false, message: "La fecha de compra es obligatoria." };

  let totals: ReturnType<typeof buildPurchaseTotals>;
  try {
    totals = buildPurchaseTotals(input.items ?? [], input.shipping_amount);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Revisa las lineas de compra." };
  }

  const admin = getSupabaseAdminClient();
  const { data: supplier, error: supplierError } = await admin
    .from("suppliers")
    .select("id, name, is_active")
    .eq("id", supplierId)
    .maybeSingle<{ id: string; name: string; is_active: boolean }>();

  if (supplierError || !supplier) {
    return { ok: false, message: "El proveedor seleccionado no existe." };
  }

  if (!supplier.is_active) {
    return { ok: false, message: "El proveedor seleccionado esta inactivo." };
  }

  const headerPayload = {
    supplier_id: supplierId,
    purchase_number: purchaseNumber,
    purchase_date: purchaseDate,
    subtotal: totals.subtotal,
    tax_amount: totals.taxAmount,
    discount_amount: totals.discountAmount,
    shipping_amount: totals.shippingAmount,
    total: totals.total,
    currency,
    notes: cleanText(input.notes),
    updated_at: new Date().toISOString(),
  };

  if (input.id) {
    const { data: existing, error: existingError } = await admin
      .from("purchases")
      .select("id, status")
      .eq("id", input.id)
      .maybeSingle<{ id: string; status: PurchaseStatus }>();

    if (existingError || !existing) {
      return { ok: false, message: "La compra no existe." };
    }

    if (existing.status !== "draft") {
      return { ok: false, message: "Solo se pueden editar compras en borrador." };
    }

    const { data, error } = await admin
      .from("purchases")
      .update(headerPayload)
      .eq("id", input.id)
      .select("id, purchase_number, total, status")
      .single();

    if (error) {
      return { ok: false, message: purchaseErrorMessage(error.message) };
    }

    for (const item of totals.normalizedItems) {
      if (item.id) {
        const { error: itemError } = await admin
          .from("purchase_items")
          .update({
            product_id: item.product_id,
            description: item.description,
            quantity: item.quantity,
            unit_cost: item.unit_cost,
            tax_amount: item.tax_amount,
            discount_amount: item.discount_amount,
            total_cost: item.total_cost,
          })
          .eq("id", item.id)
          .eq("purchase_id", input.id);

        if (itemError) return { ok: false, message: "No se pudo actualizar una linea de compra." };
      } else {
        const { error: itemError } = await admin.from("purchase_items").insert({
          purchase_id: input.id,
          product_id: item.product_id,
          description: item.description,
          quantity: item.quantity,
          unit_cost: item.unit_cost,
          tax_amount: item.tax_amount,
          discount_amount: item.discount_amount,
          total_cost: item.total_cost,
        });

        if (itemError) return { ok: false, message: "No se pudo agregar una linea de compra." };
      }
    }

    await writeAuditLog({ tableName: "purchases", recordId: data.id, action: "purchases.update", newData: { purchase_number: data.purchase_number, total: data.total, status: data.status } });
    revalidatePath("/admin/compras");
    return { ok: true, message: "Compra actualizada." };
  }

  const { data, error } = await admin
    .from("purchases")
    .insert({ ...headerPayload, status: "draft", created_by: profile.id })
    .select("id, purchase_number, total, status")
    .single();

  if (error) {
    return { ok: false, message: purchaseErrorMessage(error.message) };
  }

  if (totals.normalizedItems.length > 0) {
    const { error: itemsError } = await admin.from("purchase_items").insert(
      totals.normalizedItems.map((item) => ({
        purchase_id: data.id,
        product_id: item.product_id,
        description: item.description,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        tax_amount: item.tax_amount,
        discount_amount: item.discount_amount,
        total_cost: item.total_cost,
      })),
    );

    if (itemsError) {
      return { ok: false, message: "La compra fue creada, pero no se pudieron guardar sus lineas. Revisa la compra antes de continuar." };
    }
  }

  await writeAuditLog({ tableName: "purchases", recordId: data.id, action: "purchases.create", newData: { purchase_number: data.purchase_number, total: data.total, status: data.status } });
  revalidatePath("/admin/compras");
  return { ok: true, message: "Compra registrada en borrador." };
}

export async function confirmPurchaseAction(purchaseId: string): Promise<ActionResult> {
  const profile = await requirePermission("purchases:manage");
  const admin = getSupabaseAdminClient();

  const { data: purchase, error: purchaseError } = await admin
    .from("purchases")
    .select("id, purchase_number, status")
    .eq("id", purchaseId)
    .maybeSingle<{ id: string; purchase_number: string; status: PurchaseStatus }>();

  if (purchaseError || !purchase) return { ok: false, message: "La compra no existe." };
  if (purchase.status !== "draft") return { ok: false, message: "Solo se pueden confirmar compras en borrador." };

  const { count, error: countError } = await admin
    .from("purchase_items")
    .select("id", { count: "exact", head: true })
    .eq("purchase_id", purchaseId);

  if (countError) return { ok: false, message: "No se pudieron validar las lineas de compra." };
  if (!count) return { ok: false, message: "Agrega al menos una linea antes de confirmar." };

  const { error } = await admin
    .from("purchases")
    .update({ status: "confirmed", confirmed_by: profile.id, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", purchaseId);

  if (error) return { ok: false, message: "No se pudo confirmar la compra." };

  await writeAuditLog({ tableName: "purchases", recordId: purchaseId, action: "purchases.confirm", newData: { purchase_number: purchase.purchase_number, status: "confirmed" } });
  revalidatePath("/admin/compras");
  return { ok: true, message: "Compra confirmada." };
}

export async function cancelPurchaseAction(purchaseId: string): Promise<ActionResult> {
  const profile = await requirePermission("purchases:manage");
  const admin = getSupabaseAdminClient();

  const { data: purchase, error: purchaseError } = await admin
    .from("purchases")
    .select("id, purchase_number, status")
    .eq("id", purchaseId)
    .maybeSingle<{ id: string; purchase_number: string; status: PurchaseStatus }>();

  if (purchaseError || !purchase) return { ok: false, message: "La compra no existe." };
  if (!["draft", "confirmed"].includes(purchase.status)) return { ok: false, message: "Esta compra ya no se puede cancelar." };

  const [{ count: invoiceCount, error: invoiceError }, { count: payableCount, error: payableError }] = await Promise.all([
    admin.from("supplier_invoices").select("id", { count: "exact", head: true }).eq("purchase_id", purchaseId).neq("status", "cancelled"),
    admin.from("accounts_payable").select("id", { count: "exact", head: true }).eq("purchase_id", purchaseId).neq("status", "cancelled"),
  ]);

  if (invoiceError || payableError) return { ok: false, message: "No se pudieron validar dependencias de la compra." };
  if ((invoiceCount ?? 0) > 0 || (payableCount ?? 0) > 0) {
    return { ok: false, message: "No se puede cancelar una compra con factura o cuenta por pagar activa." };
  }

  const { error } = await admin
    .from("purchases")
    .update({ status: "cancelled", cancelled_by: profile.id, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", purchaseId);

  if (error) return { ok: false, message: "No se pudo cancelar la compra." };

  await writeAuditLog({ tableName: "purchases", recordId: purchaseId, action: "purchases.cancel", newData: { purchase_number: purchase.purchase_number, status: "cancelled" } });
  revalidatePath("/admin/compras");
  return { ok: true, message: "Compra cancelada." };
}
