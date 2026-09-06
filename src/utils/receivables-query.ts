import type {
  AdminAccountsReceivableRow,
  AdminReceivableFilter,
  AdminReceivableSort,
  AdminReceivableSortDirection,
} from "@/types/credit";

const statusLabels: Record<string, string> = {
  open: "abierto pendiente",
  partial: "pago parcial",
  paid: "pagado",
  overdue: "vencido",
  cancelled: "cancelado",
};
const paymentLabels: Record<string, string> = {
  bank_transfer: "transferencia bancaria",
  card: "tarjeta",
  cash: "efectivo",
};

export function normalizeReceivableSearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

export function receivableMatchesSearch(row: AdminAccountsReceivableRow, query: string) {
  const needle = normalizeReceivableSearch(query);
  if (!needle) return true;
  const haystack = normalizeReceivableSearch([
    row.customer_name,
    row.customer_email,
    row.customer_phone,
    row.order_number,
    row.invoice_number,
    statusLabels[row.status],
    row.payment_received_reference,
    row.payment_received_method ? paymentLabels[row.payment_received_method] : null,
    ...row.payments.flatMap((payment) => [payment.reference, paymentLabels[payment.payment_method]]),
  ].filter(Boolean).join(" "));
  return haystack.includes(needle);
}

export function receivableMatchesFilter(row: AdminAccountsReceivableRow, filter: AdminReceivableFilter) {
  if (filter === "all") return true;
  if (filter === "pending") return row.status !== "paid" && row.status !== "cancelled";
  return row.status === filter;
}

export function sortReceivables(
  rows: AdminAccountsReceivableRow[],
  sort: AdminReceivableSort,
  direction: AdminReceivableSortDirection,
) {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    let comparison = 0;
    if (sort === "due") comparison = left.due_date.localeCompare(right.due_date);
    else if (sort === "balance") comparison = left.balance_due - right.balance_due;
    else comparison = left.created_at.localeCompare(right.created_at);
    return comparison === 0 ? left.id.localeCompare(right.id) * factor : comparison * factor;
  });
}

export function filterAndSortReceivables(
  rows: AdminAccountsReceivableRow[],
  input: { filter: AdminReceivableFilter; query: string; sort: AdminReceivableSort; direction: AdminReceivableSortDirection },
) {
  return sortReceivables(
    rows.filter((row) => receivableMatchesFilter(row, input.filter) && receivableMatchesSearch(row, input.query)),
    input.sort,
    input.direction,
  );
}
