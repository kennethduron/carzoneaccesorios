export type CustomerPaginationCriteria = {
  query: string;
  filter: string;
};

export function customerCriteriaChanged(
  next: CustomerPaginationCriteria,
  current: CustomerPaginationCriteria,
) {
  return next.query.trim() !== current.query.trim() || next.filter !== current.filter;
}

export function buildCustomerPaginationHref({
  basePath,
  query,
  filter,
  page,
}: CustomerPaginationCriteria & {
  basePath: string;
  page: number;
}) {
  const params = new URLSearchParams();
  const normalizedQuery = query.trim();

  if (normalizedQuery) params.set("q", normalizedQuery);
  if (filter !== "clients") params.set("filter", filter);
  if (page > 1) params.set("page", String(page));

  const nextQuery = params.toString();
  return nextQuery ? `${basePath}?${nextQuery}` : basePath;
}
