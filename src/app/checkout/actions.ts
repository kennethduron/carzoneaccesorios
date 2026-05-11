"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { configureCloudinary } from "@/lib/cloudinary";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { CheckoutData, PriceMode } from "@/types/commerce";

type CheckoutOrderItemInput = {
  productId: string;
  quantity: number;
};

type CreateCheckoutOrderInput = {
  checkout: CheckoutData;
  items: CheckoutOrderItemInput[];
  priceMode: PriceMode;
  wholesaleCode?: string | null;
  wholesaleCodeId?: string | null;
};

type CheckoutActionResult = {
  ok: boolean;
  message: string;
  orderNumber?: string;
  transferReceiptUrl?: string | null;
};

function paymentMethodValue(method: CheckoutData["paymentMethod"]) {
  if (method === "Tarjeta") {
    return "card";
  }

  if (method === "Efectivo") {
    return "cash";
  }

  return "bank_transfer";
}

function parseCheckoutOrderInput(formData: FormData): CreateCheckoutOrderInput {
  return {
    checkout: JSON.parse(String(formData.get("checkout") ?? "{}")) as CheckoutData,
    items: JSON.parse(String(formData.get("items") ?? "[]")) as CheckoutOrderItemInput[],
    priceMode: String(formData.get("priceMode") ?? "retail") as PriceMode,
    wholesaleCode: String(formData.get("wholesaleCode") ?? "").trim() || null,
    wholesaleCodeId: String(formData.get("wholesaleCodeId") ?? "").trim() || null,
  };
}

async function uploadTransferReceipt(file: File | null, bankReference: string) {
  if (!file || file.size === 0) {
    return null;
  }

  const isImage = file.type.startsWith("image/");
  const isPdf = file.type === "application/pdf";

  if (!isImage && !isPdf) {
    throw new Error("Solo se permiten comprobantes en imagen o PDF.");
  }

  if (file.size > 8 * 1024 * 1024) {
    throw new Error("El comprobante no puede superar 8 MB.");
  }

  const cloudinary = configureCloudinary();
  const buffer = Buffer.from(await file.arrayBuffer());
  const extension = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "archivo";
  const publicId = `${bankReference.replace(/[^a-z0-9]/gi, "-").slice(0, 40) || "transferencia"}-${randomUUID()}.${extension}`;

  return new Promise<string>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "car-zone/comprobantes-transferencia",
        public_id: publicId,
        resource_type: "auto",
        overwrite: false,
      },
      (error, uploadResult) => {
        if (error || !uploadResult?.secure_url) {
          reject(error ?? new Error("Cloudinary no devolvio una URL valida para el comprobante."));
          return;
        }

        resolve(uploadResult.secure_url);
      },
    );

    stream.end(buffer);
  });
}

export async function createCheckoutOrderAction(formData: FormData): Promise<CheckoutActionResult> {
  let input: CreateCheckoutOrderInput;

  try {
    input = parseCheckoutOrderInput(formData);
  } catch {
    return { ok: false, message: "No se pudo leer la informacion del checkout." };
  }

  const customerName = input.checkout.customerName.trim();
  const phone = input.checkout.phone.trim();
  const deliveryAddress = input.checkout.address.trim();
  const email = input.checkout.email.trim() || null;
  const paymentMethod = paymentMethodValue(input.checkout.paymentMethod);
  const bankReference = input.checkout.bankTransferReference.trim();

  if (!customerName || !phone || !deliveryAddress || input.items.length === 0) {
    return { ok: false, message: "Completa tus datos y agrega productos para crear el pedido." };
  }

  if (paymentMethod === "bank_transfer" && !bankReference) {
    return { ok: false, message: "Debes ingresar el numero de referencia de la transferencia." };
  }

  if (input.priceMode === "wholesale" && (!input.wholesaleCode?.trim() || !input.wholesaleCodeId?.trim())) {
    return { ok: false, message: "Debes validar un codigo mayorista antes de comprar con precio mayorista." };
  }

  const normalizedItems = input.items
    .map((item) => ({
      productId: item.productId,
      quantity: Math.trunc(Number(item.quantity)),
    }))
    .filter((item) => item.productId && item.quantity > 0);

  if (normalizedItems.length === 0) {
    return { ok: false, message: "Agrega productos validos para crear el pedido." };
  }

  let transferReceiptUrl: string | null = null;

  try {
    const receiptFile = formData.get("transferReceipt");
    transferReceiptUrl =
      paymentMethod === "bank_transfer" && receiptFile instanceof File
        ? await uploadTransferReceipt(receiptFile, bankReference)
        : null;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "No se pudo subir el comprobante de transferencia.",
    };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .rpc("create_checkout_order", {
      customer_name: customerName,
      customer_email: email,
      customer_phone: phone,
      delivery_address: deliveryAddress,
      requested_price_mode: input.priceMode,
      requested_payment_method: paymentMethod,
      bank_reference_number: paymentMethod === "bank_transfer" ? bankReference : null,
      order_items: normalizedItems.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
      })),
      wholesale_code: input.wholesaleCode?.trim().toUpperCase() || null,
      wholesale_code_id: input.wholesaleCodeId || null,
      transfer_receipt_url: transferReceiptUrl,
    })
    .returns<Array<{ order_id: string; order_number: string }>>();

  if (error) {
    return { ok: false, message: error.message || "No se pudo crear el pedido." };
  }

  const rows = (Array.isArray(data) ? data : []) as Array<{ order_id: string; order_number: string }>;
  const createdOrder = rows[0];

  if (!createdOrder) {
    return { ok: false, message: "No se pudo crear el pedido." };
  }

  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/inventario");
  revalidatePath("/admin/reportes");
  revalidatePath("/catalogo");

  return {
    ok: true,
    message: "Pedido creado correctamente. El admin o la contadora podran revisarlo para facturacion.",
    orderNumber: createdOrder.order_number,
    transferReceiptUrl,
  };
}
