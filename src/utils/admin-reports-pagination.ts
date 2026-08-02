export const defaultAdminReportsPageSize = 50;
export const maxAdminReportsPageSize = 100;

type SearchParamsRecord = Record<string, string | string[] | undefined>;

export type ReportsPaginationPlan = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  from: number;
  to: number;
};

export type ReportsSourceRange = {
  queryFrom: number;
  queryTo: number;
  sliceFrom: number;
  sliceTo: number;
};

export type ReportsReadError = {
  code?: string;
  details?: string;
  message: string;
};

export type ReportsPageRead<T> = {
  rows: T[];
  error: ReportsReadError | null;
  rangeInvalidated: boolean;
};

const reportFilterKeys = [
  "startDate",
  "endDate",
  "customer",
  "product",
  "sku",
  "invoice",
  "paymentMethod",
  "priceMode",
  "invoiceStatus",
  "orderStatus",
] as const;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function parsePositivePage(value: unknown) {
  const page = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function normalizeReportsPageSize(
  value: unknown,
  fallback = defaultAdminReportsPageSize,
  maximum = maxAdminReportsPageSize,
) {
  const pageSize = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    return fallback;
  }

  return Math.min(pageSize, maximum);
}

export function calculateReportsTotalPages(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}

export function clampReportsPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, page), Math.max(1, totalPages));
}

export function planReportsPagination(requestedPage: number, pageSize: number, total: number): ReportsPaginationPlan {
  const safePageSize = normalizeReportsPageSize(pageSize);
  const safeTotal = Math.max(0, Math.floor(total));
  const totalPages = calculateReportsTotalPages(safeTotal, safePageSize);
  const page = clampReportsPage(parsePositivePage(requestedPage), totalPages);
  const from = (page - 1) * safePageSize;

  return {
    page,
    pageSize: safePageSize,
    total: safeTotal,
    totalPages,
    from,
    to: safeTotal === 0 ? -1 : Math.min(from + safePageSize - 1, safeTotal - 1),
  };
}

export function planReportsSourceRange(sourceTotal: number, plan: ReportsPaginationPlan): ReportsSourceRange | null {
  const safeSourceTotal = Math.max(0, Math.floor(sourceTotal));
  if (safeSourceTotal === 0 || plan.from >= safeSourceTotal) {
    return null;
  }

  // Read one page of look-behind so deleting the former last row between the
  // count and data queries cannot turn the offset into a PostgREST 416.
  const queryFrom = Math.max(0, plan.from - plan.pageSize);
  const queryTo = Math.min(plan.from + plan.pageSize - 1, safeSourceTotal - 1);
  const sliceFrom = plan.from - queryFrom;

  return {
    queryFrom,
    queryTo,
    sliceFrom,
    sliceTo: sliceFrom + plan.pageSize,
  };
}

export function isReportsRangeInvalidated(error: ReportsReadError | null) {
  return error?.code === "PGRST103" || error?.message === "Requested range not satisfiable";
}

export async function readReportsSourcePage<T>(
  sourceTotal: number,
  plan: ReportsPaginationPlan,
  readRange: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: ReportsReadError | null }>,
): Promise<ReportsPageRead<T>> {
  const range = planReportsSourceRange(sourceTotal, plan);
  if (!range) {
    return { rows: [], error: null, rangeInvalidated: false };
  }

  const result = await readRange(range.queryFrom, range.queryTo);
  if (isReportsRangeInvalidated(result.error)) {
    return { rows: [], error: null, rangeInvalidated: true };
  }

  return {
    rows: (result.data ?? []).slice(range.sliceFrom, range.sliceTo),
    error: result.error,
    rangeInvalidated: false,
  };
}

export function buildAdminReportsUrl(params: SearchParamsRecord, page: number, pageSize: number) {
  const search = new URLSearchParams();

  for (const key of reportFilterKeys) {
    const value = firstParam(params[key]);
    if (value && value !== "all") {
      search.set(key, value);
    }
  }

  if (pageSize !== defaultAdminReportsPageSize) {
    search.set("pageSize", String(pageSize));
  }

  if (page > 1) {
    search.set("page", String(page));
  }

  const query = search.toString();
  return query ? `/admin/reportes?${query}` : "/admin/reportes";
}

export function hasCanonicalReportsPagination(params: SearchParamsRecord, page: number, pageSize: number) {
  const expectedPage = page > 1 ? String(page) : undefined;
  const expectedPageSize = pageSize !== defaultAdminReportsPageSize ? String(pageSize) : undefined;
  return firstParam(params.page) === expectedPage && firstParam(params.pageSize) === expectedPageSize;
}
