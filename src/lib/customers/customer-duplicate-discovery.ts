import type {
  CrmDuplicateCandidate,
  CrmDuplicateGroup,
  CrmDuplicateMatchReason,
} from "@/types/crm";

export type CustomerDuplicateDiscoveryRow = {
  id: string;
  user_id: string | null;
  business_name: string | null;
  contact_name: string;
  email: string | null;
  phone: string | null;
  tax_id: string | null;
  status: string;
  active: boolean;
  is_wholesale: boolean;
  created_at: string;
};

type Counts = {
  orders: Map<string, number>;
  invoices: Map<string, number>;
  receivables?: Map<string, number>;
  notes?: Map<string, number>;
  creditAccounts?: Set<string>;
};

const reasonPriority: CrmDuplicateMatchReason[] = ["email", "phone", "tax_id", "business_name", "contact_name"];
const genericTokens = new Set([
  "auto",
  "autos",
  "car",
  "hn",
  "honduras",
  "cliente",
  "clientes",
  "taller",
  "servicio",
  "servicios",
  "repuestos",
  "accesorios",
]);

export function normalizeCustomerDiscoveryName(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function isSafeCustomerDiscoveryName(value: string | null | undefined) {
  const normalized = normalizeCustomerDiscoveryName(value);
  const tokens = normalized.split(" ").filter(Boolean);
  if (normalized.length < 8 || tokens.length < 2) return false;
  if (tokens.every((token) => genericTokens.has(token) || token.length < 3)) return false;
  return true;
}

function normalizeEmail(value: string | null) {
  return value?.trim().toLowerCase() || null;
}

function normalizePhone(value: string | null) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 8) return `+504${digits}`;
  if (digits.length === 11 && digits.startsWith("504")) return `+${digits}`;
  return `+${digits}`;
}

function normalizeTaxId(value: string | null) {
  const normalized = String(value ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.length >= 8 ? normalized : null;
}

function toCandidate(row: CustomerDuplicateDiscoveryRow, counts: Counts): CrmDuplicateCandidate {
  const email = normalizeEmail(row.email);
  return {
    id: row.id,
    display_name: row.business_name ?? row.contact_name,
    business_name: row.business_name,
    contact_name: row.contact_name,
    email: row.email,
    phone: row.phone,
    tax_id: row.tax_id,
    status: row.status,
    active: row.active,
    account_type: row.is_wholesale ? "wholesale" : "retail",
    has_portal_account: Boolean(row.user_id),
    created_at: row.created_at,
    order_count: counts.orders.get(row.id) ?? 0,
    invoice_count: counts.invoices.get(row.id) ?? 0,
    open_receivable_count: counts.receivables?.get(row.id) ?? 0,
    note_count: counts.notes?.get(row.id) ?? 0,
    has_credit_account: counts.creditAccounts?.has(row.id) ?? false,
    is_test_account: Boolean(email && (email.endsWith("@example.com") || email.includes("+test@"))),
    can_merge: true,
  };
}

function compareCandidatePriority(left: CrmDuplicateCandidate, right: CrmDuplicateCandidate) {
  if (left.invoice_count !== right.invoice_count) return right.invoice_count - left.invoice_count;
  if (left.order_count !== right.order_count) return right.order_count - left.order_count;
  if (left.has_portal_account !== right.has_portal_account) return left.has_portal_account ? -1 : 1;
  return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
}

function classification(reasons: Set<CrmDuplicateMatchReason>): CrmDuplicateGroup["classification"] {
  if (reasons.has("email") || reasons.has("phone") || reasons.has("tax_id")) return "strong";
  if (reasons.has("business_name")) return "probable";
  return "weak";
}

export function buildCustomerDuplicateGroups(
  customers: CustomerDuplicateDiscoveryRow[],
  counts: Counts,
  limit = 12,
): CrmDuplicateGroup[] {
  const buckets = new Map<string, { reason: CrmDuplicateMatchReason; label: string; rows: CustomerDuplicateDiscoveryRow[] }>();
  const pairs = new Map<string, { rows: [CustomerDuplicateDiscoveryRow, CustomerDuplicateDiscoveryRow]; reasons: Set<CrmDuplicateMatchReason>; labels: Map<CrmDuplicateMatchReason, string> }>();
  const businessNames = new Map<string, CustomerDuplicateDiscoveryRow[]>();
  const contactNames = new Map<string, CustomerDuplicateDiscoveryRow[]>();

  function addBucket(reason: CrmDuplicateMatchReason, key: string | null, label: string | null, row: CustomerDuplicateDiscoveryRow) {
    if (!key || !label) return;
    const bucketKey = `${reason}:${key}`;
    const bucket = buckets.get(bucketKey) ?? { reason, label, rows: [] };
    bucket.rows.push(row);
    buckets.set(bucketKey, bucket);
  }

  for (const customer of customers) {
    addBucket("email", normalizeEmail(customer.email), customer.email, customer);
    addBucket("phone", normalizePhone(customer.phone), normalizePhone(customer.phone), customer);
    addBucket("tax_id", normalizeTaxId(customer.tax_id), customer.tax_id, customer);
    if (isSafeCustomerDiscoveryName(customer.business_name)) {
      const normalized = normalizeCustomerDiscoveryName(customer.business_name);
      addBucket("business_name", normalized, customer.business_name, customer);
      businessNames.set(normalized, [...(businessNames.get(normalized) ?? []), customer]);
    }
    if (isSafeCustomerDiscoveryName(customer.contact_name)) {
      const normalized = normalizeCustomerDiscoveryName(customer.contact_name);
      addBucket("contact_name", normalized, customer.contact_name, customer);
      contactNames.set(normalized, [...(contactNames.get(normalized) ?? []), customer]);
    }
  }

  for (const bucket of buckets.values()) {
    if (bucket.rows.length < 2) continue;
    if (["business_name", "contact_name"].includes(bucket.reason) && bucket.rows.length > 10) continue;
    for (let leftIndex = 0; leftIndex < bucket.rows.length - 1; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < bucket.rows.length; rightIndex += 1) {
        const left = bucket.rows[leftIndex];
        const right = bucket.rows[rightIndex];
        const ids = [left.id, right.id].sort();
        const pairKey = ids.join(":");
        const pair = pairs.get(pairKey) ?? { rows: [left, right], reasons: new Set(), labels: new Map() };
        pair.reasons.add(bucket.reason);
        pair.labels.set(bucket.reason, bucket.label);
        pairs.set(pairKey, pair);
      }
    }
  }

  for (const [normalizedName, businessRows] of businessNames) {
    const contactRows = contactNames.get(normalizedName) ?? [];
    if (businessRows.length + contactRows.length > 20) continue;
    for (const businessRow of businessRows) {
      for (const contactRow of contactRows) {
        if (businessRow.id === contactRow.id) continue;
        const ids = [businessRow.id, contactRow.id].sort();
        const pairKey = ids.join(":");
        const pair = pairs.get(pairKey) ?? { rows: [businessRow, contactRow], reasons: new Set(), labels: new Map() };
        pair.reasons.add("business_name");
        pair.labels.set("business_name", businessRow.business_name ?? contactRow.contact_name);
        pairs.set(pairKey, pair);
      }
    }
  }

  return Array.from(pairs.entries())
    .map(([key, pair]) => {
      const customersForPair = pair.rows.map((row) => toCandidate(row, counts)).sort(compareCandidatePriority);
      const reasons = reasonPriority.filter((reason) => pair.reasons.has(reason));
      const primaryReason = reasons[0];
      return {
        key: `pair:${key}`,
        match_type: primaryReason,
        match_reasons: reasons,
        classification: classification(pair.reasons),
        label: pair.labels.get(primaryReason) ?? customersForPair[0].display_name,
        customers: customersForPair,
      } satisfies CrmDuplicateGroup;
    })
    .sort((left, right) => {
      const rank = { strong: 0, probable: 1, weak: 2 } as const;
      if (rank[left.classification] !== rank[right.classification]) return rank[left.classification] - rank[right.classification];
      return left.customers[0].display_name.localeCompare(right.customers[0].display_name, "es");
    })
    .slice(0, Math.max(1, Math.min(limit, 50)));
}
