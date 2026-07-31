"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { configureCloudinary } from "@/lib/cloudinary";
import { writeErrorLog } from "@/lib/error-logging";
import { createInternalNotification } from "@/lib/notifications/notification-center";
import { notifyAdminsOfNewOrder } from "@/lib/notifications/order-email";
import { revalidateProductAvailability } from "@/lib/product-availability-cache";
import { checkRateLimit, getRateLimitMessage } from "@/lib/rate-limit";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";
import { getPortalCommercialContextV2 } from "@/services/supabase/portal-commercial-context.service";
import { ensureMyPortalCustomerProfile } from "@/lib/auth/portal-customer-sync";
import type { CheckoutData, PriceMode } from "@/types/commerce";
import type { PortalCommercialBlockCode, PortalCommercialWarningCode } from "@/types/portal-commercial";
import { cashOnDeliveryApplies } from "@/utils/cash-on-delivery";
import { validateHondurasPhone } from "@/utils/validation";

import type { CheckoutV4Code, CheckoutV4Result } from '@/types/checkout-v4';

type CheckoutOrderItemInput = {
  productId: string;
  variantId?: string | null;
  quantity: number;
  expectedUnitPrice?: number;
};

type CreateCheckoutOrderInput = {
  checkout: CheckoutData;
  items: CheckoutOrderItemInput[];
  requestKey: string;
  recoveryToken: string;
  expectedCommercialVersion: number | null;
  expectedContextToken: string | null;
  expectedPriceMode: PriceMode;
};

type CheckoutActionResult = CheckoutV4Result;

type TransferReceiptUpload = {
  publicId: string;
  resourceType: string;
  deliveryType: string;
  format: string | null;
  originalFilename: string | null;
};

export type WholesalePurchaseStatusResult = {
  ok: boolean;
  isFirstWholesalePurchase: boolean;
  message?: string;
};

export type CheckoutAccountInfo = {
  checkoutV4Enabled: boolean;
  userId: string | null;
  contextStatus:
    | 'guest'
    | 'authenticated_retail'
    | 'authenticated_wholesale'
    | 'authenticated_credit'
    | 'commercial_context_unavailable'
    | 'commercial_context_conflict';
  reasonCode: string | null;
  isAuthenticated: boolean;
  email: string | null;
  customerName: string | null;
  phone: string | null;
  rtn: string | null;
  address: string | null;
  city: string | null;
  credit: {
    creditLimit: number;
    termsDays: number;
    usedCredit: number;
    availableCredit: number;
    overdueBalance: number;
    enabled: boolean;
    status: "active" | "suspended" | null;
    usable: boolean;
    blockCodes: PortalCommercialBlockCode[];
    warningCodes: PortalCommercialWarningCode[];
  } | null;
  linked: boolean;
  effectivePriceMode: "retail" | "wholesale";
  commercialVersion: number | null;
  contextToken: string | null;
};

type CheckoutProductPriceRow = {
  id: string;
  name: string;
  retail_price: number | null;
  wholesale_price: number | null;
  wholesale_min_quantity: number | null;
};

const wholesaleMessages = {
  loginRequired: "Inicia sesión con tu cuenta mayorista aprobada para activar precios.",
  accountNotAuthorized: "Tu cuenta no está autorizada para compras mayoristas.",
};
const hondurasOnlyMessage = "Actualmente solo realizamos entregas dentro de Honduras.";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const bankReferencePattern = /^[A-Za-z0-9 -]+$/;

function isUuid(value: string) {
  return uuidPattern.test(value);
}

function safeCheckoutErrorMessage(message: string) {
  const normalized = message.toLowerCase();
  const genericCheckoutMessage = "No se pudo crear el pedido. Revisa la información e inténtalo nuevamente.";

  if (normalized.includes("commercial_context_changed")) {
    return "Tus condiciones comerciales cambiaron. Actualizamos el checkout; revisa el total e inténtalo nuevamente.";
  }

  if (normalized.includes("checkout_idempotency_conflict")) {
    return "Esta solicitud ya fue usada con datos diferentes. Actualiza el checkout e inténtalo nuevamente.";
  }

  if (normalized.includes("checkout_customer_changed")) {
    return "La sesión del cliente cambió. Actualiza la página antes de continuar.";
  }

  if (normalized.includes("wholesale_not_available")) {
    return "El precio mayorista ya no está disponible para esta sesión. Actualiza el carrito.";
  }

  if (normalized.includes("credit_not_available")) {
    return "El crédito comercial no está disponible para este pedido. Revisa el método de pago.";
  }

  if (normalized.includes("checkout_invalid_input")) {
    return "Los datos del checkout no son válidos. Revisa el carrito e inténtalo nuevamente.";
  }

  if (normalized.includes("checkout_internal_error")) {
    return genericCheckoutMessage;
  }

  if (
    normalized.includes("solo hay") ||
    normalized.includes("stock") ||
    normalized.includes("inventario") ||
    normalized.includes("ya no esta disponible") ||
    normalized.includes("ya no está disponible") ||
    normalized.includes("no tiene stock suficiente")
  ) {
    return "La cantidad solicitada ya no está disponible. Este producto fue tomado por otro cliente; actualiza tu carrito para continuar.";
  }

  if (normalized.includes("invalid input syntax for type uuid")) {
    return "Hay un producto inválido en el carrito. Elimínalo y vuelve a intentar.";
  }

  if (normalized.includes("row-level security") || normalized.includes("permission denied") || normalized.includes("rls")) {
    return "No tienes permiso para realizar esta acción.";
  }

  if (normalized.includes("duplicate key") || normalized.includes("unique constraint")) {
    return "Ya existe un registro con esos datos. Revisa la información e intenta nuevamente.";
  }

  if (
    normalized.includes("primera compra mayorista") ||
    normalized.includes("minimo requerido") ||
    normalized.includes("compra minima") ||
    normalized.includes("compra mínima") ||
    normalized.includes("cantidad minima mayorista") ||
    normalized.includes("cantidad mínima mayorista")
  ) {
    return message;
  }

  if (
    normalized.includes("credit_account") ||
    normalized.includes("record \"") ||
    normalized.includes("pl/pgsql") ||
    normalized.includes("tuple structure") ||
    normalized.includes("not-yet-assigned") ||
    normalized.includes("sql state") ||
    /\b[a-z]+(?:_[a-z0-9]+)+\b/.test(message)
  ) {
    return genericCheckoutMessage;
  }

  if (normalized.includes("checkout") || normalized.includes("products") || normalized.includes("uuid") || normalized.includes("rpc")) {
    return "No pudimos procesar tu pedido. Revisa los productos del carrito e intenta nuevamente.";
  }

  return message || "No pudimos procesar tu pedido. Revisa los productos del carrito e intenta nuevamente.";
}

function paymentMethodValue(method: CheckoutData["paymentMethod"]) {
  const normalizedMethod = String(method);

  if (normalizedMethod === "Crédito Comercial") {
    return "commercial_credit";
  }

  if (method === "Tarjeta") {
    return "card";
  }

  if (method === "Efectivo") {
    return "cash";
  }

  return "bank_transfer";
}

function parseCheckoutOrderInput(formData: FormData): CreateCheckoutOrderInput {
  const versionValue = String(formData.get("expectedCommercialVersion") ?? "").trim();
  const contextTokenValue = String(formData.get("expectedContextToken") ?? "").trim();
  const priceModeValue = String(formData.get("expectedPriceMode") ?? "retail");

  return {
    checkout: JSON.parse(String(formData.get("checkout") ?? "{}")) as CheckoutData,
    items: JSON.parse(String(formData.get("items") ?? "[]")) as CheckoutOrderItemInput[],
    requestKey: String(formData.get("requestKey") ?? ""),
    recoveryToken: String(formData.get("recoveryToken") ?? ""),
    expectedCommercialVersion: versionValue === "" ? null : Number(versionValue),
    expectedContextToken: contextTokenValue || null,
    expectedPriceMode: priceModeValue === "wholesale" ? "wholesale" : "retail",
  };
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function validateBankReference(value: string) {
  const reference = value.trim().replace(/\s+/g, " ");

  if (!reference) {
    return { ok: false as const, message: "Ingresa el número de referencia bancaria." };
  }

  if (reference.length < 4) {
    return { ok: false as const, message: "La referencia bancaria debe tener al menos 4 caracteres." };
  }

  if (reference.length > 80) {
    return { ok: false as const, message: "La referencia bancaria no debe superar 80 caracteres." };
  }

  if (!bankReferencePattern.test(reference)) {
    return { ok: false as const, message: "La referencia bancaria solo puede incluir letras, números, espacios y guiones." };
  }

  return { ok: true as const, value: reference };
}

export async function getCheckoutAccountAction(): Promise<CheckoutAccountInfo> {
  const guestAccount: CheckoutAccountInfo = {
    checkoutV4Enabled: false,
    userId: null,
    contextStatus: 'guest',
    reasonCode: null,
    isAuthenticated: false,
    email: null,
    customerName: null,
    phone: null,
    rtn: null,
    address: null,
    city: null,
    credit: null,
    linked: false,
    effectivePriceMode: "retail",
    commercialVersion: null,
    contextToken: null,
  };

  const supabase = await getSupabaseServerClient();
  const useCheckoutV4 = await checkoutV4Enabled(supabase);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ...guestAccount, checkoutV4Enabled: useCheckoutV4 };
  }

  const commercial = await getPortalCommercialContextV2();
  const admin = getSupabaseAdminClient();
  const [{ data: profile }, { data: customer }] = await Promise.all([
    admin
      .from("users")
      .select("email, full_name, phone")
      .eq("id", user.id)
      .maybeSingle<{ email: string | null; full_name: string | null; phone: string | null }>(),
    admin
      .from("customers")
      .select("id, contact_name, email, phone, tax_id, address, city")
      .eq("id", commercial.customerId ?? "00000000-0000-0000-0000-000000000000")
      .limit(1)
      .maybeSingle<{
        id: string;
        contact_name: string | null;
        email: string | null;
        phone: string | null;
        tax_id: string | null;
        address: string | null;
        city: string | null;
      }>(),
  ]);

  const accountEmail = normalizeEmail(user.email || profile?.email || customer?.email);

  return {
    checkoutV4Enabled: useCheckoutV4,
    userId: user.id,
    contextStatus: commercial.resolutionStatus,
    reasonCode: commercial.reasonCode,
    isAuthenticated: true,
    email: accountEmail || null,
    customerName: customer?.contact_name || profile?.full_name || null,
    phone: customer?.phone || profile?.phone || null,
    rtn: customer?.tax_id || null,
    address: customer?.address || null,
    city: customer?.city || null,
    credit: commercial.creditAccountExists
      ? {
          creditLimit: commercial.creditLimit ?? 0,
          termsDays: commercial.creditTermsDays ?? 0,
          usedCredit: commercial.creditUsed ?? 0,
          availableCredit: commercial.creditAvailable ?? 0,
          overdueBalance: commercial.overdueBalance ?? 0,
          enabled: commercial.creditEnabled,
          status: commercial.creditStatus,
          usable: commercial.creditUsable,
          blockCodes: commercial.blockCodes,
          warningCodes: commercial.warningCodes,
        }
      : null,
    linked: commercial.linked,
    effectivePriceMode: commercial.effectivePriceMode,
    commercialVersion: commercial.commercialVersion,
    contextToken: commercial.contextToken,
  };
}

export async function getWholesalePurchaseStatusAction(customerId: string | null): Promise<WholesalePurchaseStatusResult> {
  if (!customerId || !isUuid(customerId)) {
    return { ok: false, isFirstWholesalePurchase: true, message: "Cuenta mayorista no valida." };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, isFirstWholesalePurchase: true, message: wholesaleMessages.loginRequired };
  }

  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("user_id", user.id)
    .eq("wholesale_status", "approved")
    .eq("active", true)
    .maybeSingle<{ id: string }>();

  if (customerError || !customer) {
    return { ok: false, isFirstWholesalePurchase: true, message: wholesaleMessages.accountNotAuthorized };
  }

  const { data, error } = await supabase.rpc("has_completed_wholesale_order", { target_customer_id: customerId });

  if (error) {
    return { ok: false, isFirstWholesalePurchase: true, message: "No se pudo validar historial mayorista." };
  }

  return { ok: true, isFirstWholesalePurchase: !Boolean(data) };
}

async function uploadTransferReceipt(file: File | null, bankReference: string): Promise<TransferReceiptUpload | null> {
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
  const publicId = `${bankReference.replace(/[^a-z0-9]/gi, "-").slice(0, 40) || "transferencia"}-${randomUUID()}`;

  return new Promise<TransferReceiptUpload>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "car-zone/comprobantes-transferencia-privados",
        public_id: publicId,
        resource_type: "auto",
        type: "authenticated",
        overwrite: false,
        use_filename: false,
        unique_filename: false,
        context: {
          source: "checkout_bank_transfer",
        },
      },
      (error, uploadResult) => {
        if (error || !uploadResult?.public_id) {
          reject(error ?? new Error("Cloudinary no devolvio una URL valida para el comprobante."));
          return;
        }

        resolve({
          publicId: uploadResult.public_id,
          resourceType: uploadResult.resource_type ?? (isPdf ? "raw" : "image"),
          deliveryType: uploadResult.type ?? "authenticated",
          format: uploadResult.format ?? extension,
          originalFilename: file.name.slice(0, 180),
        });
      },
    );

    stream.end(buffer);
  });
}

type CheckoutRequestStatusRpc = {
  status?: string;
  replayed?: boolean;
  orderNumber?: string | null;
  trackingCode?: string | null;
  createdAt?: string | null;
  priceMode?: PriceMode | null;
  total?: number | null;
  errorCode?: string | null;
  code?: string | null;
  retryAllowed?: boolean;
  expiresAt?: string | null;
};

const checkoutV4Codes = new Set<CheckoutV4Code>([
  'CHECKOUT_SESSION_REQUIRED',
  'CHECKOUT_CUSTOMER_LINK_REQUIRED',
  'CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE',
  'CHECKOUT_COMMERCIAL_CONTEXT_CHANGED',
  'CHECKOUT_PRICE_CHANGED',
  'CHECKOUT_STOCK_CHANGED',
  'CHECKOUT_WHOLESALE_PRICE_UNAVAILABLE',
  'CHECKOUT_WHOLESALE_MINIMUM_QUANTITY',
  'CHECKOUT_WHOLESALE_FIRST_MINIMUM',
  'CHECKOUT_REQUEST_CONFLICT',
  'CHECKOUT_REQUEST_EXPIRED',
  'CHECKOUT_REQUEST_NOT_FOUND',
  'CHECKOUT_CREDIT_LIMIT_EXCEEDED',
  'CHECKOUT_PAYMENT_METHOD_UNAVAILABLE',
  'CHECKOUT_BANK_REFERENCE_REQUIRED',
  'CHECKOUT_PRODUCT_UNAVAILABLE',
  'CHECKOUT_TEMPORARILY_UNAVAILABLE',
]);

function checkoutV4ErrorCode(value: unknown): CheckoutV4Code {
  const text = value instanceof Error ? value.message : String(value ?? '');
  for (const code of checkoutV4Codes) {
    if (text.includes(code)) return code;
  }
  return 'CHECKOUT_TEMPORARILY_UNAVAILABLE';
}

function checkoutV4Message(code: string) {
  const messages: Record<string, string> = {
    CHECKOUT_SESSION_REQUIRED:
      'Tu sesión terminó antes de confirmar. El pedido no fue creado y tu carrito se conserva. Inicia sesión nuevamente para continuar.',
    CHECKOUT_CUSTOMER_LINK_REQUIRED:
      'Tu cuenta necesita estar vinculada a un cliente antes de crear pedidos. El carrito se conserva; contacta a Car Zone Accesorios.',
    CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE:
      'No pudimos verificar temporalmente tus condiciones comerciales. No se creó ningún pedido y tu carrito se conserva.',
    CHECKOUT_COMMERCIAL_CONTEXT_CHANGED:
      'Tus condiciones comerciales cambiaron. Actualizamos los precios; revísalos y confirma nuevamente.',
    CHECKOUT_PRICE_CHANGED:
      'Uno o más precios cambiaron. No se creó el pedido; revisa el carrito actualizado y confirma nuevamente.',
    CHECKOUT_STOCK_CHANGED:
      'La disponibilidad cambió antes de confirmar. No se creó el pedido; actualiza el carrito para continuar.',
    CHECKOUT_WHOLESALE_PRICE_UNAVAILABLE:
      'Un producto no tiene un precio mayorista válido. No se creó el pedido y tu carrito se conserva.',
    CHECKOUT_WHOLESALE_MINIMUM_QUANTITY:
      'Una cantidad ya no cumple el mínimo mayorista. Corrige el carrito y confirma nuevamente.',
    CHECKOUT_WHOLESALE_FIRST_MINIMUM:
      'El pedido no alcanza el mínimo requerido para la primera compra mayorista.',
    CHECKOUT_REQUEST_CONFLICT:
      'Esta solicitud ya fue usada con información diferente. No se creó un pedido adicional.',
    CHECKOUT_REQUEST_EXPIRED:
      'La solicitud de checkout expiró. Tu carrito se conserva y puedes iniciar una nueva confirmación.',
    CHECKOUT_REQUEST_NOT_FOUND:
      'No encontramos una solicitud pendiente. Tu carrito se conserva y puedes intentarlo nuevamente.',
    CHECKOUT_CREDIT_LIMIT_EXCEEDED:
      'Este pedido supera el crédito disponible. No se creó el pedido; elige otra forma de pago o ajusta el carrito.',
    CHECKOUT_PAYMENT_METHOD_UNAVAILABLE:
      'La forma de pago seleccionada no está disponible en este momento.',
    CHECKOUT_BANK_REFERENCE_REQUIRED:
      'Ingresa la referencia bancaria para confirmar la transferencia.',
    CHECKOUT_PRODUCT_UNAVAILABLE:
      'Uno de los productos ya no está disponible. No se creó el pedido; actualiza el carrito.',
    CHECKOUT_TEMPORARILY_UNAVAILABLE:
      'No pudimos confirmar el estado del pedido. Conserva esta pantalla: intentaremos recuperar la solicitud sin duplicarla.',
  };
  return messages[code] ?? messages.CHECKOUT_TEMPORARILY_UNAVAILABLE;
}

function isRetryableCheckoutV4Code(code: string) {
  return [
    'CHECKOUT_SESSION_REQUIRED',
    'CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE',
    'CHECKOUT_COMMERCIAL_CONTEXT_CHANGED',
    'CHECKOUT_PRICE_CHANGED',
    'CHECKOUT_STOCK_CHANGED',
    'CHECKOUT_REQUEST_NOT_FOUND',
    'CHECKOUT_TEMPORARILY_UNAVAILABLE',
  ].includes(code);
}

async function checkoutV4Enabled(supabase: Awaited<ReturnType<typeof getSupabaseServerClient>>) {
  const { data, error } = await supabase.rpc('get_checkout_feature_flag_v1');
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) return false;
  return (data as { enabled?: unknown }).enabled === true;
}

export async function getCheckoutRequestStatusAction(
  requestKey: string,
  recoveryToken: string,
): Promise<CheckoutActionResult> {
  if (!isUuid(requestKey) || recoveryToken.length > 256) {
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: 'failed_final',
      code: 'CHECKOUT_REQUEST_NOT_FOUND',
      retryAllowed: true,
      message: checkoutV4Message('CHECKOUT_REQUEST_NOT_FOUND'),
    };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_checkout_request_status_v1', {
    p_request_key: requestKey,
    p_recovery_token: recoveryToken || null,
  });

  if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
    const code = checkoutV4ErrorCode(error?.message);
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: 'failed_retryable',
      code,
      retryAllowed: true,
      message: checkoutV4Message(code),
    };
  }

  const row = data as CheckoutRequestStatusRpc;
  const committed = row.status === 'committed' && Boolean(row.orderNumber) && Boolean(row.trackingCode);
  return {
    ok: committed,
    checkoutVersion: 4,
    requestStatus: (row.status ?? 'failed_retryable') as CheckoutV4Result['requestStatus'],
    replayed: row.replayed === true,
    retryAllowed: row.retryAllowed === true,
    orderNumber: row.orderNumber ?? undefined,
    trackingCode: row.trackingCode ?? undefined,
    createdAt: row.createdAt ?? undefined,
    priceMode: row.priceMode ?? undefined,
    total: row.total === null || row.total === undefined ? undefined : Number(row.total),
    code: row.errorCode ?? row.code ?? undefined,
    message: committed
      ? 'Recuperamos tu pedido creado correctamente.'
      : checkoutV4Message(row.errorCode ?? row.code ?? 'CHECKOUT_TEMPORARILY_UNAVAILABLE'),
  };
}

export async function recordCheckoutConfirmationShownAction(
  requestKey: string,
  recoveryToken: string,
  recovered: boolean,
  durationMs: number | null,
) {
  if (!isUuid(requestKey) || recoveryToken.length > 256) return { ok: false };
  const supabase = await getSupabaseServerClient();
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_URL ?? null;
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const eventName = recovered ? 'checkout_response_recovered' : 'checkout_response_built';

  await supabase.rpc('record_checkout_browser_event_v1', {
    p_request_key: requestKey,
    p_recovery_token: recoveryToken || null,
    p_event_name: eventName,
    p_deployment_id: deploymentId,
    p_commit_sha: commitSha,
    p_duration_ms: durationMs,
  });
  const { error } = await supabase.rpc('record_checkout_browser_event_v1', {
    p_request_key: requestKey,
    p_recovery_token: recoveryToken || null,
    p_event_name: 'checkout_confirmation_shown',
    p_deployment_id: deploymentId,
    p_commit_sha: commitSha,
    p_duration_ms: durationMs,
  });
  return { ok: !error };
}

async function createCheckoutOrderV4Atomic(input: {
  supabase: Awaited<ReturnType<typeof getSupabaseServerClient>>;
  checkoutInput: CreateCheckoutOrderInput;
  customerName: string;
  email: string;
  phone: string;
  customerRtn: string | null;
  department: string;
  city: string;
  deliveryAddress: string;
  paymentMethod: string;
  paymentTiming: string;
  bankReference: string;
  normalizedItems: Array<{ productId: string; quantity: number; expectedUnitPrice: number }>;
  transferReceipt: TransferReceiptUpload | null;
}): Promise<CheckoutActionResult> {
  const { supabase, checkoutInput } = input;
  const commercial = await getPortalCommercialContextV2();
  const actorScope = commercial.authenticated ? 'authenticated' : 'guest';

  if (commercial.resolutionStatus === 'commercial_context_unavailable') {
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: 'failed_retryable',
      code: 'CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE',
      retryAllowed: true,
      message: checkoutV4Message('CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE'),
    };
  }
  if (commercial.resolutionStatus === 'commercial_context_conflict') {
    const code = commercial.reasonCode || 'CHECKOUT_CUSTOMER_LINK_REQUIRED';
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: 'failed_final',
      code,
      retryAllowed: code === 'CHECKOUT_SESSION_REQUIRED',
      message: checkoutV4Message(code),
    };
  }

  if (
    commercial.contextToken !== checkoutInput.expectedContextToken ||
    commercial.commercialVersion !== checkoutInput.expectedCommercialVersion ||
    commercial.effectivePriceMode !== checkoutInput.expectedPriceMode
  ) {
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: 'failed_retryable',
      code: 'CHECKOUT_COMMERCIAL_CONTEXT_CHANGED',
      retryAllowed: true,
      message: checkoutV4Message('CHECKOUT_COMMERCIAL_CONTEXT_CHANGED'),
    };
  }

  const cartItems = input.normalizedItems.map((item) => ({
    product_id: item.productId,
    variant_id: null,
    quantity: item.quantity,
  }));
  const { data: cartData, error: cartError } = await supabase.rpc('resolve_checkout_cart_v4', {
    p_cart_items: cartItems,
    p_guest_intent: actorScope === 'guest',
  });

  if (cartError || !cartData || typeof cartData !== 'object' || Array.isArray(cartData)) {
    const code = checkoutV4ErrorCode(cartError?.message);
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: 'failed_retryable',
      code,
      retryAllowed: true,
      message: checkoutV4Message(code),
    };
  }

  const cart = cartData as {
    ok?: boolean;
    code?: string | null;
    cartFingerprint?: string;
    lines?: Array<{ productId?: string; unitPrice?: unknown }>;
    context?: { contextToken?: string; commercialVersion?: unknown; priceMode?: PriceMode };
  };
  if (cart.ok !== true || !cart.cartFingerprint || !Array.isArray(cart.lines)) {
    const code = cart.code || 'CHECKOUT_TEMPORARILY_UNAVAILABLE';
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: isRetryableCheckoutV4Code(code) ? 'failed_retryable' : 'failed_final',
      code,
      retryAllowed: isRetryableCheckoutV4Code(code),
      message: checkoutV4Message(code),
    };
  }

  const expectedPriceByProduct = new Map(
    input.normalizedItems.map((item) => [item.productId, Number(item.expectedUnitPrice)]),
  );
  const priceChanged = cart.lines.some((line) => {
    const expected = line.productId ? expectedPriceByProduct.get(line.productId) : undefined;
    return expected === undefined || !Number.isFinite(expected) || Math.abs(Number(line.unitPrice) - expected) > 0.001;
  });
  if (priceChanged) {
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: 'failed_retryable',
      code: 'CHECKOUT_PRICE_CHANGED',
      retryAllowed: true,
      message: checkoutV4Message('CHECKOUT_PRICE_CHANGED'),
    };
  }

  const recoveryToken = checkoutInput.recoveryToken;
  const customerData = {
    name: input.customerName,
    email: input.email,
    phone: input.phone,
    rtn: input.customerRtn,
    email_updates_opt_in: Boolean(checkoutInput.checkout.receiveOrderEmailUpdates),
    bank_reference: input.bankReference || null,
  };
  const deliveryData = {
    country: 'Honduras',
    country_code: 'HN',
    department: input.department,
    city: input.city,
    address: input.deliveryAddress,
    mode: 'home_delivery',
  };
  const { data: beginData, error: beginError } = await supabase.rpc('begin_checkout_request_v1', {
    p_request_key: checkoutInput.requestKey,
    p_recovery_token: recoveryToken,
    p_expected_actor_scope: actorScope,
    p_expected_context_token: commercial.contextToken,
    p_expected_commercial_version: commercial.commercialVersion,
    p_cart_fingerprint: cart.cartFingerprint,
    p_cart_items: cartItems,
    p_customer_data: customerData,
    p_delivery_data: deliveryData,
    p_payment_method: input.paymentMethod,
    p_payment_timing: input.paymentTiming,
  });

  if (beginError || !beginData || typeof beginData !== 'object' || Array.isArray(beginData)) {
    const code = checkoutV4ErrorCode(beginError?.message);
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: 'failed_retryable',
      code,
      retryAllowed: true,
      message: checkoutV4Message(code),
    };
  }

  const begun = beginData as CheckoutRequestStatusRpc & {
    ok?: boolean;
    requestFingerprint?: string;
    priceMode?: PriceMode;
  };
  if (begun.status === 'committed' && begun.orderNumber && begun.trackingCode) {
    return {
      ok: true,
      checkoutVersion: 4,
      requestStatus: 'committed',
      replayed: true,
      retryAllowed: false,
      orderNumber: begun.orderNumber,
      trackingCode: begun.trackingCode,
      createdAt: begun.createdAt ?? new Date().toISOString(),
      priceMode: begun.priceMode ?? commercial.effectivePriceMode,
      total: Number(begun.total ?? 0),
      emailStatus: 'queued',
      message: 'Recuperamos tu pedido creado correctamente.',
    };
  }
  if (begun.ok !== true || !begun.requestFingerprint) {
    const code = begun.code || 'CHECKOUT_TEMPORARILY_UNAVAILABLE';
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: (begun.status ?? 'failed_retryable') as CheckoutV4Result['requestStatus'],
      code,
      retryAllowed: begun.retryAllowed === true,
      message: checkoutV4Message(code),
    };
  }

  const paymentData = {
    bank_reference: input.bankReference || null,
    receipt_public_id: input.transferReceipt?.publicId ?? null,
    receipt_resource_type: input.transferReceipt?.resourceType ?? null,
    receipt_delivery_type: input.transferReceipt?.deliveryType ?? null,
    receipt_format: input.transferReceipt?.format ?? null,
    receipt_original_filename: input.transferReceipt?.originalFilename ?? null,
  };
  const { data: createData, error: createError } = await supabase.rpc('create_checkout_order_v4', {
    p_request_key: checkoutInput.requestKey,
    p_request_fingerprint: begun.requestFingerprint,
    p_expected_context_token: commercial.contextToken,
    p_expected_commercial_version: commercial.commercialVersion,
    p_cart_fingerprint: cart.cartFingerprint,
    p_cart_items: cartItems,
    p_customer_data: customerData,
    p_delivery_data: deliveryData,
    p_payment_method: input.paymentMethod,
    p_payment_timing: input.paymentTiming,
    p_payment_data: paymentData,
  });

  if (createError || !createData || typeof createData !== 'object' || Array.isArray(createData)) {
    const code = checkoutV4ErrorCode(createError?.message);
    const retryable = isRetryableCheckoutV4Code(code);
    await supabase.rpc('mark_checkout_request_failed_v1', {
      p_request_key: checkoutInput.requestKey,
      p_request_fingerprint: begun.requestFingerprint,
      p_recovery_token: recoveryToken,
      p_error_code: code,
      p_retryable: retryable,
    });
    await writeErrorLog({
      route: '/checkout',
      action: 'checkout_v4.create_failed',
      errorMessage: code,
      userId: commercial.userId,
      metadata: {
        checkout_version: 4,
        actor_scope: actorScope,
        expected_tier: checkoutInput.expectedPriceMode,
        resolved_tier: commercial.effectivePriceMode,
        commercial_version: commercial.commercialVersion,
        line_count: cartItems.length,
        error_code: code,
      },
    });
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: retryable ? 'failed_retryable' : 'failed_final',
      code,
      retryAllowed: retryable,
      message: checkoutV4Message(code),
    };
  }

  const created = createData as {
    ok?: boolean;
    status?: string;
    replayed?: boolean;
    orderNumber?: string;
    trackingCode?: string;
    createdAt?: string;
    priceMode?: PriceMode;
    subtotal?: unknown;
    tax?: unknown;
    shipping?: unknown;
    total?: unknown;
    emailStatus?: string;
  };
  if (created.ok !== true || created.status !== 'committed' || !created.orderNumber || !created.trackingCode) {
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: 'failed_retryable',
      code: 'CHECKOUT_TEMPORARILY_UNAVAILABLE',
      retryAllowed: true,
      message: checkoutV4Message('CHECKOUT_TEMPORARILY_UNAVAILABLE'),
    };
  }

  revalidatePath('/admin/pedidos');
  revalidatePath('/admin/inventario');
  revalidatePath('/admin/reportes');
  revalidateProductAvailability();

  return {
    ok: true,
    checkoutVersion: 4,
    requestStatus: 'committed',
    replayed: created.replayed === true,
    retryAllowed: false,
    orderNumber: created.orderNumber,
    trackingCode: created.trackingCode,
    createdAt: created.createdAt ?? new Date().toISOString(),
    priceMode: created.priceMode ?? commercial.effectivePriceMode,
    subtotal: Number(created.subtotal ?? 0),
    tax: Number(created.tax ?? 0),
    shipping: Number(created.shipping ?? 0),
    total: Number(created.total ?? 0),
    emailStatus: created.emailStatus === 'queued' ? 'queued' : 'not_queued',
    message: created.replayed
      ? 'Recuperamos tu pedido creado correctamente.'
      : 'Pedido creado correctamente. El correo quedó en cola y no retrasó la confirmación.',
  };
}
export async function createCheckoutOrderAction(formData: FormData): Promise<CheckoutActionResult> {
  let input: CreateCheckoutOrderInput;

  try {
    input = parseCheckoutOrderInput(formData);
  } catch {
    return { ok: false, message: "No se pudo leer la información del checkout." };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const accountEmail = normalizeEmail(user?.email);
  const submittedEmail = normalizeEmail(input.checkout.email);
  const useCheckoutV4 = await checkoutV4Enabled(supabase);

  if (!isUuid(input.requestKey)) {
    return { ok: false, message: "Actualiza el checkout e inténtalo nuevamente." };
  }

  if (
    (input.expectedCommercialVersion !== null &&
      (!Number.isInteger(input.expectedCommercialVersion) || input.expectedCommercialVersion < 0)) ||
    (input.expectedContextToken !== null && !/^[0-9a-f]{64}$/.test(input.expectedContextToken))
  ) {
    return { ok: false, code: "COMMERCIAL_CONTEXT_CHANGED", message: "Actualiza el checkout e inténtalo nuevamente." };
  }

  if (
    input.expectedPriceMode === "wholesale"
    && (
      !user
      || input.expectedCommercialVersion === null
      || input.expectedContextToken === null
    )
  ) {
    return {
      ok: false,
      code: "COMMERCIAL_CONTEXT_CHANGED",
      message: "No pudimos verificar temporalmente su condición comercial. Su carrito se conserva. Actualice la sesión o intente nuevamente.",
    };
  }

  if (!useCheckoutV4 && user) {
    try {
      const profileSync = await ensureMyPortalCustomerProfile(
        supabase,
        user.id,
        "checkout_recovery",
        input.requestKey,
      );

      if (!profileSync.ok) {
        await writeErrorLog({
          route: "/checkout",
          action: "checkout.portal_customer_profile_review_required",
          errorMessage: profileSync.code,
          userId: user.id,
          metadata: {
            sync_code: profileSync.code,
            sync_state: profileSync.state ?? null,
          },
        });

        return {
          ok: false,
          message: "Tu cuenta requiere revisión antes de crear el pedido. Contacta al equipo de Car Zone Accesorios.",
        };
      }
    } catch (syncError) {
      await writeErrorLog({
        route: "/checkout",
        action: "checkout.portal_customer_profile_recovery_failed",
        errorMessage: syncError instanceof Error ? syncError.message : "Portal customer profile recovery failed.",
        userId: user.id,
        metadata: {
          recovery_available: true,
        },
      });

      return {
        ok: false,
        message: "No pudimos validar tu perfil de cliente. Actualiza la página e inténtalo nuevamente.",
      };
    }
  }

  const checkoutLimit = await checkRateLimit({
    route: "/checkout",
    limit: 6,
    windowSeconds: 10 * 60,
    key: user?.id ? `user:${user.id}` : submittedEmail || String(input.checkout.phone || "").trim().toLowerCase(),
  });

  if (!checkoutLimit.ok) {
    return { ok: false, message: getRateLimitMessage(checkoutLimit.retryAfter) };
  }

  const customerName = String(input.checkout.customerName ?? "").trim();
  const country = String(input.checkout.country ?? "").trim();
  const department = String(input.checkout.department ?? "").trim();
  const city = String(input.checkout.city ?? "").trim();
  const phoneResult = validateHondurasPhone(input.checkout.phone);
  const customerRtn = String(input.checkout.rtn ?? "").trim() || null;
  const deliveryAddress = String(input.checkout.address ?? "").trim();
  const email = user ? accountEmail : submittedEmail;
  const paymentMethod = paymentMethodValue(input.checkout.paymentMethod);
  const paymentTiming =
    paymentMethod === "commercial_credit"
      ? "before_delivery"
      : paymentMethod === "cash"
      ? "on_delivery"
      : paymentMethod === "card"
        ? "before_delivery"
        : input.checkout.paymentTiming === "on_delivery"
          ? "on_delivery"
          : "before_delivery";
  const requiresCashOnDeliveryReview = cashOnDeliveryApplies(paymentMethod, paymentTiming);
  const bankReferenceResult =
    paymentMethod === "bank_transfer" && paymentTiming === "before_delivery"
      ? validateBankReference(String(input.checkout.bankTransferReference ?? ""))
      : { ok: true as const, value: "" };
  const bankReference = bankReferenceResult.ok ? bankReferenceResult.value : "";
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const settings = await getPublicCompanySettings();
  const priceMode = input.expectedPriceMode;

  if (country !== "Honduras") {
    return { ok: false, message: hondurasOnlyMessage };
  }

  if (!phoneResult.ok) {
    return { ok: false, message: phoneResult.message };
  }

  const phone = phoneResult.value;

  if (user && !email) {
    return { ok: false, message: "No pudimos validar el correo de tu cuenta. Cierra sesión e inicia sesión nuevamente." };
  }

  if (!user && (!email || !emailPattern.test(email))) {
    return { ok: false, message: "Ingresa un correo válido para el pedido." };
  }

  if (!customerName || !department || !city || !deliveryAddress || rawItems.length === 0) {
    return { ok: false, message: "Completa tus datos y agrega productos para crear el pedido." };
  }

  if (paymentMethod === "bank_transfer" && !settings.allow_bank_transfer) {
    return { ok: false, message: "La transferencia bancaria no está disponible en este momento." };
  }

  if (paymentMethod === "cash" && !settings.allow_cash_on_delivery) {
    return { ok: false, message: "El pago contra entrega no está disponible en este momento." };
  }

  if (paymentMethod === "commercial_credit" && !user) {
    return { ok: false, message: "Inicia sesión con una cuenta autorizada para usar crédito comercial." };
  }

  if (!bankReferenceResult.ok) {
    return { ok: false, message: bankReferenceResult.message };
  }

  const normalizedItems = rawItems
    .map((item) => ({
      productId: String(item.productId ?? ""),
      variantId: item.variantId ? String(item.variantId) : null,
      quantity: Math.trunc(Number(item.quantity)),
      expectedUnitPrice: Number(item.expectedUnitPrice),
    }))
    .filter((item) => item.productId && item.quantity > 0)
    .sort((left, right) => left.productId.localeCompare(right.productId));

  if (normalizedItems.length === 0) {
    return { ok: false, message: "Agrega productos válidos para crear el pedido." };
  }

  if (normalizedItems.some((item) => !isUuid(item.productId))) {
    await writeErrorLog({
      route: "/checkout",
      action: "checkout.invalid_product_id",
      errorMessage: "Checkout received a non-UUID product id.",
      metadata: {
        product_ids: normalizedItems.map((item) => item.productId),
      },
    });

    return {
      ok: false,
      message: "Hay un producto inválido en el carrito. Elimínalo y vuelve a intentar.",
    };
  }

  if (
    useCheckoutV4 &&
    (
      !input.recoveryToken ||
      input.recoveryToken.length < 32 ||
      input.recoveryToken.length > 256 ||
      normalizedItems.some((item) => !Number.isFinite(item.expectedUnitPrice) || item.expectedUnitPrice < 0)
    )
  ) {
    return {
      ok: false,
      checkoutVersion: 4,
      requestStatus: 'failed_final',
      code: 'CHECKOUT_REQUEST_CONFLICT',
      retryAllowed: false,
      message: checkoutV4Message('CHECKOUT_REQUEST_CONFLICT'),
    };
  }

  const productIds = Array.from(new Set(normalizedItems.map((item) => item.productId)));
  const { data: availableProducts, error: productsError } = await getSupabaseAdminClient()
    .from("products")
    .select("id, name, retail_price, wholesale_price, wholesale_min_quantity")
    .in("id", productIds)
    .eq("active", true)
    .eq("status", "active")
    .returns<CheckoutProductPriceRow[]>();

  if (productsError) {
    await writeErrorLog({
      route: "/checkout",
      action: "checkout.product_validation_failed",
      errorMessage: productsError.message,
      metadata: {
        product_ids: productIds,
      },
    });

    return { ok: false, message: "No pudimos procesar tu pedido. Revisa los productos del carrito e intenta nuevamente." };
  }

  const availableProductIds = new Set((availableProducts ?? []).map((product) => product.id));
  if (productIds.some((productId) => !availableProductIds.has(productId))) {
    return {
      ok: false,
      message: "Uno de los productos de tu carrito ya no está disponible. Elimínalo y vuelve a intentar.",
    };
  }

  if (priceMode === "wholesale") {
    if (!settings.wholesale_purchases_enabled) {
      return { ok: false, message: "Las compras mayoristas están desactivadas temporalmente." };
    }

    if (!user) {
      return { ok: false, message: wholesaleMessages.accountNotAuthorized };
    }

    const wholesaleQuantityIssues = normalizedItems
      .map((item) => {
        const product = (availableProducts ?? []).find((entry) => entry.id === item.productId);
        const minimumQuantity = Math.max(1, Math.trunc(Number(product?.wholesale_min_quantity ?? 1)));

        if (
          !product ||
          minimumQuantity <= 1 ||
          Number(product.wholesale_price ?? 0) <= 0 ||
          Number(product.wholesale_price ?? 0) >= Number(product.retail_price ?? 0) ||
          item.quantity >= minimumQuantity
        ) {
          return null;
        }

        return {
          name: product.name,
          quantity: item.quantity,
          minimumQuantity,
        };
      })
      .filter(Boolean) as Array<{ name: string; quantity: number; minimumQuantity: number }>;

    if (wholesaleQuantityIssues.length > 0) {
      const detail = wholesaleQuantityIssues
        .map((item) => `${item.name} requiere mínimo ${item.minimumQuantity} unidades; tienes ${item.quantity}`)
        .join("; ");
      return {
        ok: false,
        message:
          wholesaleQuantityIssues.length === 1
            ? `No se puede crear el pedido. El producto ${wholesaleQuantityIssues[0].name} requiere mínimo ${wholesaleQuantityIssues[0].minimumQuantity} unidades para compra mayorista.`
            : `No se puede crear el pedido. Corrige las cantidades mínimas mayoristas antes de crear el pedido: ${detail}.`,
      };
    }

  }

  let transferReceipt: TransferReceiptUpload | null = null;

  try {
    const receiptFile = formData.get("transferReceipt");
    transferReceipt =
      paymentMethod === "bank_transfer" && paymentTiming === "before_delivery" && receiptFile instanceof File
        ? await uploadTransferReceipt(receiptFile, bankReference)
        : null;
  } catch (error) {
    await writeErrorLog({
      route: "/checkout",
      action: "checkout.transfer_receipt_upload_failed",
      errorMessage: error instanceof Error ? error.message : "Transfer receipt upload failed.",
      errorStack: error instanceof Error ? error.stack : null,
      metadata: {
        payment_method: paymentMethod,
        bank_reference: bankReference,
      },
    });

    return {
      ok: false,
      message:
        error instanceof Error && (error.message.includes("imagen") || error.message.includes("8 MB"))
          ? error.message
          : "No se pudo subir el comprobante de transferencia. Revisa el archivo e intenta nuevamente.",
    };
  }

  if (useCheckoutV4) {
    return createCheckoutOrderV4Atomic({
      supabase,
      checkoutInput: input,
      customerName,
      email,
      phone,
      customerRtn,
      department,
      city,
      deliveryAddress,
      paymentMethod,
      paymentTiming,
      bankReference,
      normalizedItems,
      transferReceipt,
    });
  }

  const { data, error } = await supabase
    .rpc("create_checkout_order_v3", {
      p_request_key: input.requestKey,
      p_expected_commercial_version: input.expectedCommercialVersion,
      p_expected_context_token: input.expectedContextToken,
      p_customer_name: customerName,
      p_customer_email: email,
      p_customer_phone: phone,
      p_customer_rtn: customerRtn,
      p_delivery_address: deliveryAddress,
      p_delivery_country: "Honduras",
      p_country_code: "HN",
      p_delivery_department: department,
      p_delivery_city: city,
      p_requested_price_mode: priceMode,
      p_requested_payment_method: paymentMethod,
      p_requested_payment_timing: paymentTiming,
      p_bank_reference_number: paymentMethod === "bank_transfer" && paymentTiming === "before_delivery" ? bankReference : null,
      p_order_items: normalizedItems.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
      })),
      p_wholesale_code: null,
      p_wholesale_code_id: null,
      p_transfer_receipt_url: null,
    })
    .returns<Array<{ order_id: string; order_number: string; tracking_code: string; idempotent_replay: boolean }>>();

  if (error) {
    await writeErrorLog({
      route: "/checkout",
      action: "checkout.create_order_failed",
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
        hint: error.hint,
        product_ids: productIds,
        price_mode: priceMode,
        payment_method: paymentMethod,
        payment_timing: paymentTiming,
      },
    });

    const code = [
      "COMMERCIAL_CONTEXT_CHANGED",
      "CHECKOUT_IDEMPOTENCY_CONFLICT",
      "CHECKOUT_CUSTOMER_CHANGED",
      "WHOLESALE_NOT_AVAILABLE",
      "CREDIT_NOT_AVAILABLE",
      "CHECKOUT_INVALID_INPUT",
      "CHECKOUT_INTERNAL_ERROR",
    ].find((candidate) => error.message.includes(candidate));

    return { ok: false, code, message: safeCheckoutErrorMessage(error.message) };
  }

  const rows = (Array.isArray(data) ? data : []) as Array<{ order_id: string; order_number: string; tracking_code: string }>;
  const createdOrder = rows[0];

  if (!createdOrder) {
    return { ok: false, message: "No se pudo crear el pedido." };
  }

  const admin = getSupabaseAdminClient();

  if (paymentMethod === "card") {
    const { error: cardPaymentMetadataError } = await admin
      .from("payments")
      .update({
        provider: "manual_payment_link",
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", createdOrder.order_id);

    if (cardPaymentMetadataError) {
      await writeErrorLog({
        route: "/checkout",
        action: "checkout.card_payment_link_metadata_failed",
        errorMessage: cardPaymentMetadataError.message,
        metadata: {
          order_id: createdOrder.order_id,
        },
      });
    }
  }

  const { error: emailPreferenceError } = await admin
    .from("orders")
    .update({
      email_updates_opt_in: Boolean(input.checkout.receiveOrderEmailUpdates),
      email_updates_preference_source: "checkout",
      email_updates_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", createdOrder.order_id);

  if (emailPreferenceError) {
    await writeErrorLog({
      route: "/checkout",
      action: "checkout.email_updates_preference_failed",
      errorMessage: emailPreferenceError.message,
      metadata: {
        order_id: createdOrder.order_id,
      },
    });
  }

  if (transferReceipt) {
    const { error: receiptMetadataError } = await admin
      .from("payments")
      .update({
        transfer_receipt_url: null,
        transfer_receipt_public_id: transferReceipt.publicId,
        transfer_receipt_resource_type: transferReceipt.resourceType,
        transfer_receipt_delivery_type: transferReceipt.deliveryType,
        transfer_receipt_format: transferReceipt.format,
        transfer_receipt_original_filename: transferReceipt.originalFilename,
        transfer_receipt_uploaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", createdOrder.order_id);

    if (receiptMetadataError) {
      await writeErrorLog({
        route: "/checkout",
        action: "checkout.transfer_receipt_metadata_failed",
        errorMessage: receiptMetadataError.message,
        metadata: {
          order_id: createdOrder.order_id,
          receipt_public_id_present: Boolean(transferReceipt.publicId),
        },
      });
    }
  }

  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/inventario");
  revalidatePath("/admin/reportes");
  revalidateProductAvailability();

  try {
    await notifyAdminsOfNewOrder({
      orderId: createdOrder.order_id,
      orderNumber: createdOrder.order_number,
      trackingCode: createdOrder.tracking_code,
    });

    if (requiresCashOnDeliveryReview) {
      await createInternalNotification({
        type: "payment.cash_on_delivery_review",
        title: "Pedido contra entrega pendiente de revisión",
        message: "Tienes un pedido contra entrega pendiente de revisión. Debes confirmar el cargo contra entrega antes de generar factura.",
        severity: "warning",
        module: "pagos",
        orderId: createdOrder.order_id,
        metadata: {
          order_number: createdOrder.order_number,
          tracking_code: createdOrder.tracking_code,
          payment_method: paymentMethod,
          payment_timing: paymentTiming,
          action_path: "/admin/pedidos?task=pending_payments",
        },
        dedupeKey: `payment.cash_on_delivery_review:${createdOrder.order_id}`,
      });
    }
  } catch (notificationError) {
    await writeErrorLog({
      route: "/checkout",
      action: "notifications.order_created_unhandled",
      errorMessage: notificationError instanceof Error ? notificationError.message : "Unhandled order notification error.",
      errorStack: notificationError instanceof Error ? notificationError.stack : null,
      metadata: {
        order_id: createdOrder.order_id,
        order_number: createdOrder.order_number,
      },
    });
  }

  return {
    ok: true,
    message:
      paymentMethod === "card"
        ? "Pedido recibido. Te contactaremos por WhatsApp para enviarte el enlace de pago."
        : requiresCashOnDeliveryReview
          ? "Tu pedido fue recibido correctamente. Seleccionaste pago contra entrega. Nuestro equipo revisará el cargo correspondiente y actualizará el total final del pedido."
        : paymentMethod === "commercial_credit"
          ? "Pedido creado con crédito comercial. El pago quedará pendiente hasta que el equipo marque el crédito como pagado."
        : "Pedido creado correctamente. Nuestro equipo revisará el pago y la facturación.",
    orderNumber: createdOrder.order_number,
    trackingCode: createdOrder.tracking_code,
    transferReceiptUrl: null,
  };
}
