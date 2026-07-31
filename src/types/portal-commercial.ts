import type { PriceMode } from "@/types/commerce";
import type { WholesaleCustomerType } from "@/types/wholesale";

export type PortalCommercialBlockCode =
  | "PORTAL_ACCOUNT_INACTIVE"
  | "PORTAL_ACCOUNT_NOT_LINKED"
  | "CUSTOMER_INACTIVE"
  | "WHOLESALE_NOT_AVAILABLE"
  | "CREDIT_ACCOUNT_NOT_FOUND"
  | "CREDIT_ACCOUNT_CONFLICT"
  | "CREDIT_DISABLED"
  | "CREDIT_SUSPENDED";

export type PortalCommercialWarningCode = "CREDIT_OVERDUE_WARNING";

export type PortalCommercialResolutionStatus =
  | 'guest'
  | 'authenticated_retail'
  | 'authenticated_wholesale'
  | 'authenticated_credit'
  | 'commercial_context_unavailable'
  | 'commercial_context_conflict';

export type PortalCommercialContext = {
  resolutionStatus: PortalCommercialResolutionStatus;
  reasonCode: string | null;
  userId: string | null;
  authenticated: boolean;
  accountActive: boolean;
  linked: boolean;
  customerId: string | null;
  commercialVersion: number | null;
  customerActive: boolean;
  effectivePriceMode: PriceMode;
  wholesaleStatus: "none" | "pending" | "approved" | "rejected" | "suspended";
  wholesaleCustomerType: WholesaleCustomerType | null;
  firstPurchaseRequired: boolean;
  firstPurchaseMinimum: number;
  firstPurchaseCompleted: boolean;
  firstPurchaseAccumulated: number;
  creditAccountExists: boolean;
  creditEnabled: boolean;
  creditStatus: "active" | "suspended" | null;
  creditLimit: number | null;
  creditUsed: number | null;
  creditAvailable: number | null;
  creditTermsDays: number | null;
  overdueBalance: number | null;
  creditUsable: boolean;
  blockCodes: PortalCommercialBlockCode[];
  warningCodes: PortalCommercialWarningCode[];
  pendingLinkEvidence: boolean;
  contextToken: string | null;
  serverTimestamp: string;
};

export function createGuestPortalCommercialContext(): PortalCommercialContext {
  return {
    resolutionStatus: 'guest',
    reasonCode: null,
    userId: null,
    authenticated: false,
    accountActive: false,
    linked: false,
    customerId: null,
    commercialVersion: null,
    customerActive: false,
    effectivePriceMode: "retail",
    wholesaleStatus: "none",
    wholesaleCustomerType: null,
    firstPurchaseRequired: false,
    firstPurchaseMinimum: 0,
    firstPurchaseCompleted: false,
    firstPurchaseAccumulated: 0,
    creditAccountExists: false,
    creditEnabled: false,
    creditStatus: null,
    creditLimit: null,
    creditUsed: null,
    creditAvailable: null,
    creditTermsDays: null,
    overdueBalance: null,
    creditUsable: false,
    blockCodes: [],
    warningCodes: [],
    pendingLinkEvidence: false,
    contextToken: null,
    serverTimestamp: new Date(0).toISOString(),
  };
}

export function createUnavailablePortalCommercialContext(authenticated: boolean): PortalCommercialContext {
  return {
    ...createGuestPortalCommercialContext(),
    resolutionStatus: 'commercial_context_unavailable',
    reasonCode: 'CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE',
    authenticated,
    blockCodes: authenticated ? ['PORTAL_ACCOUNT_INACTIVE'] : [],
    serverTimestamp: new Date().toISOString(),
  };
}
