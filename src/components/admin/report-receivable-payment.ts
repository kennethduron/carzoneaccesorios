export const historicalReceivableOrderLabel = "Cuenta histórica";

type ReceivablePaymentOrderReference = {
  order_id: string | null;
  order_number: string | null;
};

type ReceivablePaymentReportInput = ReceivablePaymentOrderReference & {
  customer_name: string;
  original_amount: number;
  total_paid: number;
  balance_due: number;
  receivable_status: string;
  due_date: string;
  payment_method: string;
  reference: string | null;
  received_at: string;
  amount: number;
};

type ReceivablePaymentReportFormatters = {
  currency: (value: number) => string;
  date: (value: string | null) => string;
  paymentMethod: (value: string | null | undefined) => string;
  status: (value: string) => string;
};

export function receivablePaymentOrderReference(payment: ReceivablePaymentOrderReference) {
  const orderNumber = payment.order_number?.trim();

  if (orderNumber) {
    return orderNumber;
  }

  return payment.order_id ? payment.order_id.slice(0, 8) : historicalReceivableOrderLabel;
}

export function buildReceivablePaymentReportRow(
  payment: ReceivablePaymentReportInput,
  formatters: ReceivablePaymentReportFormatters,
) {
  return {
    Cliente: payment.customer_name,
    Pedido: receivablePaymentOrderReference(payment),
    "Total original": formatters.currency(payment.original_amount),
    "Total abonado": formatters.currency(payment.total_paid),
    "Saldo pendiente": formatters.currency(payment.balance_due),
    Estado: formatters.status(payment.receivable_status),
    "Fecha de vencimiento": formatters.date(payment.due_date),
    "Método de abono": formatters.paymentMethod(payment.payment_method),
    Referencia: payment.reference ?? "-",
    "Fecha de abono": formatters.date(payment.received_at),
    "Monto de abono": formatters.currency(payment.amount),
  };
}

export function reportRowMatchesSearch(row: Record<string, string | number>, query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase("es-HN");

  if (!normalizedQuery) {
    return true;
  }

  return Object.values(row).some((value) =>
    String(value).toLocaleLowerCase("es-HN").includes(normalizedQuery),
  );
}
