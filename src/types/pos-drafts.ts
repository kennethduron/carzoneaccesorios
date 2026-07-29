export type {
  PosActiveDraftSummary,
  PosChargeCapabilities,
  PosDraftItem,
  PosDraftSaveInput,
  PosProductSearchPage,
  PosProductSearchResult,
  PosSaleDraft,
} from "@/types/point-of-sale";

export type PosDraftApiError = {
  code: string;
  message: string;
  currentVersion?: number;
  status?: string;
  updatedAt?: string;
};
