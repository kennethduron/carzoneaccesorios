export const financialCenterTabs = ["summary", "mappings", "events", "journal", "accounts"] as const;

export type FinancialCenterTab = (typeof financialCenterTabs)[number];

const financialCenterTabSet = new Set<string>(financialCenterTabs);

export function normalizeFinancialCenterTab(value: unknown): FinancialCenterTab {
  return typeof value === "string" && financialCenterTabSet.has(value)
    ? (value as FinancialCenterTab)
    : "summary";
}

export function buildJournalEntryViewerHref(journalEntryId: string) {
  const search = new URLSearchParams();
  search.set("tab", "journal");
  search.set("partida", journalEntryId);
  return `/admin/contabilidad?${search.toString()}`;
}
