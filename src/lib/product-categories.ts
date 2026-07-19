export const officialProductCategories = [
  { name: "Exterior", slug: "exterior", sortOrder: 10 },
  { name: "Interior", slug: "interior", sortOrder: 20 },
  { name: "Iluminación", slug: "iluminacion", sortOrder: 30 },
  { name: "Polarizado y Herramientas", slug: "polarizado-y-herramientas", sortOrder: 40 },
  { name: "Carrocería", slug: "carroceria", sortOrder: 50 },
  { name: "Seguridad", slug: "seguridad", sortOrder: 60 },
  { name: "Audio y Sonido", slug: "audio-y-sonido", sortOrder: 70 },
] as const;

export type OfficialProductCategoryName = (typeof officialProductCategories)[number]["name"];
export type OfficialProductCategorySlug = (typeof officialProductCategories)[number]["slug"];

const legacyCategoryAliases = {
  audio: "audio-y-sonido",
  herramientas: "polarizado-y-herramientas",
  luces: "iluminacion",
  tecnologia: "interior",
} as const satisfies Record<string, OfficialProductCategorySlug>;

function normalizeCategoryLookup(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const officialCategoryByLookup = new Map<string, (typeof officialProductCategories)[number]>();

for (const category of officialProductCategories) {
  officialCategoryByLookup.set(normalizeCategoryLookup(category.name), category);
  officialCategoryByLookup.set(normalizeCategoryLookup(category.slug), category);
}

export function getOfficialProductCategory(value: string | null | undefined) {
  const lookup = normalizeCategoryLookup(value);
  const canonicalSlug = legacyCategoryAliases[lookup as keyof typeof legacyCategoryAliases] ?? lookup;
  return officialCategoryByLookup.get(canonicalSlug) ?? null;
}

export function normalizeImportedProductCategoryName(value: string | null | undefined) {
  return getOfficialProductCategory(value)?.name ?? null;
}

export function normalizeProductCategorySlug(value: string | null | undefined) {
  return getOfficialProductCategory(value)?.slug ?? null;
}

export function isOfficialProductCategory(
  category: { name: string; slug: string; active?: boolean } | null | undefined,
) {
  if (!category || category.active === false) {
    return false;
  }

  const official = getOfficialProductCategory(category.slug);
  return official?.name === category.name && official.slug === category.slug;
}

export function sortOfficialProductCategories<T extends { name: string; slug: string }>(categories: T[]) {
  const categoryBySlug = new Map(
    categories
      .filter((category) => isOfficialProductCategory(category))
      .map((category) => [category.slug, category]),
  );

  return officialProductCategories
    .map((category) => categoryBySlug.get(category.slug))
    .filter((category): category is T => Boolean(category));
}
