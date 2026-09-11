export type AdminPriceViewMode = "retail" | "wholesale";

export type AdminPriceViewInitialState = {
  eligible: boolean;
  userId: string | null;
  mode: AdminPriceViewMode;
};

export type AdminWholesalePriceEntry = {
  wholesalePrice: number | null;
};

export type AdminWholesalePricesByProductId = Record<string, AdminWholesalePriceEntry>;
