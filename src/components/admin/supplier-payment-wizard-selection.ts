export type SupplierPaymentWizardSelectionRequest = {
  requestId: number;
  supplierId: string;
  accountsPayableId: string;
};

type OpenPayableCandidate = {
  id: string;
  supplier_id: string;
  status: string;
  balance: number;
};

export function isSameSupplierPaymentSelection(
  current: SupplierPaymentWizardSelectionRequest | null,
  supplierId: string,
  accountsPayableId: string,
) {
  return (
    current?.supplierId === supplierId &&
    current.accountsPayableId === accountsPayableId
  );
}

export function createSupplierPaymentSelectionRequest(
  requestId: number,
  supplierId: string,
  accountsPayableId: string,
): SupplierPaymentWizardSelectionRequest {
  return { requestId, supplierId, accountsPayableId };
}

export function isEligibleSupplierPaymentPayable<T extends OpenPayableCandidate>(
  payable: T | null | undefined,
  request: SupplierPaymentWizardSelectionRequest,
): payable is T {
  return Boolean(
    payable &&
      payable.id === request.accountsPayableId &&
      payable.supplier_id === request.supplierId &&
      ["pending", "partial", "overdue"].includes(payable.status) &&
      Number.isFinite(payable.balance) &&
      payable.balance > 0,
  );
}
