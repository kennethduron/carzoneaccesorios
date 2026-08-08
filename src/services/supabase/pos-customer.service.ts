import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  PosCustomerContext,
  PosCustomerDuplicateSuggestion,
  PosCustomerDuplicateSuggestionPage,
  PosCustomerSearchPage,
  PosCustomerSearchResult,
  PosCustomerUpdateInput,
  PosCustomerWriteInput,
  PosCustomerWriteResult,
  PosWholesaleEligibility,
} from "@/types/point-of-sale";

type SearchRow = {
  customer_id: string;
  display_name: string;
  business_name: string | null;
  phone_masked: string | null;
  email_masked: string | null;
  customer_type: PosCustomerSearchResult["customerType"];
  wholesale_status: PosCustomerSearchResult["wholesaleStatus"];
  has_portal_account: boolean;
  is_blocked: boolean;
  customer_status: PosCustomerSearchResult["customerStatus"];
  commercial_version: number | string;
  total_count: number | string;
};

type DuplicateSuggestionRow = {
  customer_id: string;
  display_name: string;
  business_name: string | null;
  phone_masked: string | null;
  email_masked: string | null;
  tax_id_masked: string | null;
  customer_status: PosCustomerDuplicateSuggestion['customerStatus'];
  wholesale_status: PosCustomerDuplicateSuggestion['wholesaleStatus'];
  has_portal_account: boolean;
  source: string | null;
  match_level: PosCustomerDuplicateSuggestion['matchLevel'];
  matched_fields: PosCustomerDuplicateSuggestion['matchedFields'];
  selectable: boolean;
  override_allowed: boolean;
};

type ContextRow = {
  customer_id: string;
  display_name: string;
  business_name: string | null;
  phone: string | null;
  email: string | null;
  tax_id: string | null;
  address: string | null;
  city: string | null;
  commercial_notes: string | null;
  customer_type: PosCustomerContext["customerType"];
  wholesale_status: PosCustomerContext["wholesaleStatus"];
  pricing_mode: PosCustomerContext["pricingMode"];
  pricing_reason: string;
  commercial_version: number | string;
  has_portal_account: boolean;
  customer_status: PosCustomerContext["customerStatus"];
  credit_status: PosCustomerContext["credit"]["status"];
  credit_enabled: boolean;
  credit_limit: number | string;
  open_balance: number | string;
  available_credit: number | string;
  overdue_balance: number | string;
  receivable_count: number | string;
  can_use_credit: boolean;
  credit_reason: string;
  order_count: number | string;
  invoice_count: number | string;
  total_billed: number | string;
};

type CreditConfigurationRow = {
  account_exists: boolean;
  terms_days: number | string;
  credit_notes: string | null;
};

type EligibilityRow = {
  eligible: boolean;
  threshold_amount: number | string;
  evaluated_amount: number | string;
  missing_amount: number | string;
  current_status: PosWholesaleEligibility["currentStatus"];
  pricing_mode: PosWholesaleEligibility["pricingMode"];
  recommended_action: string;
  commercial_version: number | string;
};

export class PosCustomerServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "PosCustomerServiceError";
  }
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeMessage(code: string | undefined, fallback: string) {
  if (code === "POS_CUSTOMER_SUSPENDED") return "Este cliente está suspendido y no puede utilizarse para una nueva venta.";
  if (code === "42501") return "Acceso denegado.";
  if (code === "P0002") return "No se encontro el cliente.";
  if (code === "22023") return "La solicitud contiene datos invalidos.";
  if (code === "55000") return "La operacion todavia esta en proceso. Intenta nuevamente.";
  if (code === "PT409") return "La configuración comercial cambió. Recarga el cliente e intenta de nuevo.";
  return fallback;
}

function throwRpcError(error: { code?: string; message?: string } | null, fallback: string): never {
  if (error?.message === "POS_CUSTOMER_SUSPENDED") {
    throw new PosCustomerServiceError(safeMessage("POS_CUSTOMER_SUSPENDED", fallback), "POS_CUSTOMER_SUSPENDED");
  }
  const code = error?.code ?? "POS_CUSTOMER_OPERATION_FAILED";
  throw new PosCustomerServiceError(safeMessage(code, fallback), code);
}

export async function searchPosCustomers(input: {
  query: string;
  limit: number;
  offset: number;
}): Promise<PosCustomerSearchPage> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("search_pos_customers_v1", {
    p_query: input.query,
    p_limit: input.limit,
    p_offset: input.offset,
    p_include_inactive: false,
  });
  if (error) throwRpcError(error, "No se pudo buscar clientes.");

  const rows = (data ?? []) as unknown as SearchRow[];
  const results: PosCustomerSearchResult[] = rows.filter((row) =>
    row.customer_status === "active" && row.wholesale_status !== "suspended",
  ).map((row) => ({
    customerId: row.customer_id,
    displayName: row.display_name,
    businessName: row.business_name,
    phoneMasked: row.phone_masked,
    emailMasked: row.email_masked,
    customerType: row.customer_type,
    wholesaleStatus: row.wholesale_status,
    hasPortalAccount: Boolean(row.has_portal_account),
    isBlocked: Boolean(row.is_blocked),
    customerStatus: row.customer_status,
    commercialVersion: numberValue(row.commercial_version),
  }));
  const total = numberValue(rows[0]?.total_count);
  return { results, total, nextOffset: input.offset + results.length < total ? input.offset + results.length : null };
}

export async function suggestPosCustomerDuplicates(input: {
  contactName: string;
  businessName: string | null;
  email: string | null;
  phone: string | null;
  taxId: string | null;
}): Promise<PosCustomerDuplicateSuggestionPage> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc('suggest_pos_customer_duplicates_v1', {
    p_contact_name: input.contactName,
    p_business_name: input.businessName,
    p_email: input.email,
    p_phone: input.phone,
    p_tax_id: input.taxId,
    p_limit: 8,
  });
  if (error) throwRpcError(error, 'No se pudieron buscar posibles clientes existentes.');
  const results = ((data ?? []) as unknown as DuplicateSuggestionRow[]).map((row) => ({
    customerId: row.customer_id,
    displayName: row.display_name,
    businessName: row.business_name,
    phoneMasked: row.phone_masked,
    emailMasked: row.email_masked,
    taxIdMasked: row.tax_id_masked,
    customerStatus: row.customer_status,
    wholesaleStatus: row.wholesale_status,
    hasPortalAccount: Boolean(row.has_portal_account),
    source: row.source,
    matchLevel: row.match_level,
    matchedFields: row.matched_fields,
    selectable: Boolean(row.selectable),
    overrideAllowed: Boolean(row.override_allowed),
  }));
  return { results, hasStrongMatch: results.some((row) => row.matchLevel === 'strong') };
}

export async function getPosCustomerContext(customerId: string): Promise<PosCustomerContext> {
  const supabase = await getSupabaseServerClient();
  const [contextResponse, configurationResponse] = await Promise.all([
    supabase.rpc("get_selectable_pos_customer_context_v1", { target_customer_id: customerId }).single<ContextRow>(),
    supabase.rpc("get_pos_customer_credit_configuration_v1", { target_customer_id: customerId }).single<CreditConfigurationRow>(),
  ]);
  const { data, error } = contextResponse;
  if (error || !data) throwRpcError(error, "No se pudo cargar el contexto del cliente.");
  if (configurationResponse.error || !configurationResponse.data) {
    throwRpcError(configurationResponse.error, "No se pudo cargar la configuración de crédito.");
  }
  const configuration = configurationResponse.data;
  if (data.customer_status !== "active" || data.wholesale_status === "suspended") {
    throw new PosCustomerServiceError(
      "Este cliente está suspendido y no puede utilizarse para una nueva venta.",
      "POS_CUSTOMER_SUSPENDED",
    );
  }

  return {
    customerId: data.customer_id,
    displayName: data.display_name,
    businessName: data.business_name,
    phone: data.phone,
    email: data.email,
    taxId: data.tax_id,
    address: data.address,
    city: data.city,
    commercialNotes: data.commercial_notes,
    customerType: data.customer_type,
    wholesaleStatus: data.wholesale_status,
    pricingMode: data.pricing_mode,
    pricingReason: data.pricing_reason,
    commercialVersion: numberValue(data.commercial_version),
    hasPortalAccount: Boolean(data.has_portal_account),
    customerStatus: data.customer_status,
    credit: {
      accountExists: Boolean(configuration.account_exists),
      status: data.credit_status,
      enabled: Boolean(data.credit_enabled),
      creditLimit: numberValue(data.credit_limit),
      termsDays: numberValue(configuration.terms_days) || 30,
      notes: configuration.credit_notes,
      openBalance: numberValue(data.open_balance),
      availableCredit: numberValue(data.available_credit),
      overdueBalance: numberValue(data.overdue_balance),
      receivableCount: numberValue(data.receivable_count),
      canUseCredit: Boolean(data.can_use_credit),
      reason: data.credit_status === "active"
        ? "Crédito comercial activo. El disponible se verificará nuevamente al confirmar."
        : data.credit_reason,
    },
    summary: {
      orderCount: numberValue(data.order_count),
      invoiceCount: numberValue(data.invoice_count),
      totalBilled: numberValue(data.total_billed),
    },
  };
}

export async function evaluatePosWholesaleEligibility(
  customerId: string,
  merchandiseFinal: number,
): Promise<PosWholesaleEligibility> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .rpc("evaluate_wholesale_eligibility_v1", {
      target_customer_id: customerId,
      merchandise_final: merchandiseFinal,
    })
    .single<EligibilityRow>();
  if (error || !data) throwRpcError(error, "No se pudo evaluar la elegibilidad mayorista.");
  return {
    eligible: Boolean(data.eligible),
    thresholdAmount: numberValue(data.threshold_amount),
    evaluatedAmount: numberValue(data.evaluated_amount),
    missingAmount: numberValue(data.missing_amount),
    currentStatus: data.current_status,
    pricingMode: data.pricing_mode,
    recommendedAction: data.recommended_action,
    commercialVersion: numberValue(data.commercial_version),
  };
}

function writeRpcInput(input: PosCustomerWriteInput) {
  return {
    p_customer_id: null,
    p_expected_commercial_version: null,
    p_request_key: input.requestKey,
    p_contact_name: input.contactName,
    p_phone: input.phone,
    p_email: input.email,
    p_business_name: input.businessName,
    p_tax_id: input.taxId,
    p_address: input.address,
    p_city: input.city,
    p_commercial_notes: input.commercialNotes,
    p_customer_type: input.customerType,
    p_credit_mode: input.creditMode,
    p_credit_limit: input.creditLimit,
    p_credit_terms_days: input.creditTermsDays,
    p_credit_notes: input.creditNotes,
    p_change_reason: input.changeReason,
    p_duplicate_override_reason: input.duplicateOverrideReason,
  };
}

export async function createPosCustomer(input: PosCustomerWriteInput): Promise<PosCustomerWriteResult> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc('save_pos_customer_commercial_profile_v2', writeRpcInput(input));
  if (error || !data) throwRpcError(error, "No se pudo crear el cliente.");
  return data as unknown as PosCustomerWriteResult;
}

export async function updatePosCustomer(input: PosCustomerUpdateInput): Promise<PosCustomerWriteResult> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc('save_pos_customer_commercial_profile_v2', {
    ...writeRpcInput(input),
    p_customer_id: input.customerId,
    p_expected_commercial_version: input.expectedCommercialVersion,
  });
  if (error || !data) throwRpcError(error, "No se pudo actualizar el cliente.");
  return data as unknown as PosCustomerWriteResult;
}
