import type { AccountingAccountType, AccountingNormalBalance } from "@/types/accounting";

export type AccountingAccountSearchResult = {
  id: string;
  code: string;
  name: string;
  accountType: AccountingAccountType;
  normalBalance: AccountingNormalBalance;
  isActive: boolean;
  parentId: string | null;
  isSelectable: boolean;
};

export type PurchaseProductSearchResult = {
  id: string;
  sku: string;
  internalCode: string | null;
  name: string;
  brand: string;
  unit: string | null;
  status: string;
  isActive: boolean;
  availableStock: number;
  costPrice: number;
};

export type InventoryProductSearchResult = {
  id: string;
  sku: string;
  internalCode: string | null;
  name: string;
  brand: string;
  categoryName: string | null;
  status: string;
  isActive: boolean;
  stock: number;
  reservedStock: number;
  availableStock: number;
  minStock: number;
  autoDisabledByStock: boolean;
};

export type AdminSearchResponse<T> = {
  results: T[];
  total: number;
  nextOffset: number | null;
};
