import type { PosCustomerContext } from "@/types/point-of-sale";

type CustomerLocation = Pick<PosCustomerContext, "address" | "city">;

function normalizeLocationPart(value: string | null) {
  return value?.trim() ?? "";
}

export function resolvePosCustomerDeliveryAddress(customer: CustomerLocation) {
  return normalizeLocationPart(customer.address)
    || normalizeLocationPart(customer.city)
    || "";
}

export function shouldPrefillPosCustomerDeliveryAddress(
  currentCustomerId: string | null,
  nextCustomerId: string,
  hasDraft: boolean,
) {
  return !hasDraft && currentCustomerId !== nextCustomerId;
}

export function resolvePosCustomerSelectionDeliveryAddress({
  currentAddress,
  currentCustomerId,
  nextCustomer,
  hasDraft,
}: {
  currentAddress: string;
  currentCustomerId: string | null;
  nextCustomer: CustomerLocation & { customerId: string };
  hasDraft: boolean;
}) {
  return shouldPrefillPosCustomerDeliveryAddress(currentCustomerId, nextCustomer.customerId, hasDraft)
    ? resolvePosCustomerDeliveryAddress(nextCustomer)
    : currentAddress;
}
