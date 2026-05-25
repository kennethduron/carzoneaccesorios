export const suggestedVehicleBrands = [
  "Toyota",
  "Honda",
  "Nissan",
  "Mazda",
  "Mitsubishi",
  "Chevrolet",
  "Kia",
  "Volkswagen",
  "Hyundai",
  "Ford",
  "Isuzu",
  "Suzuki",
  "BMW",
  "GMC",
  "BYD",
  "MG",
  "RAM",
] as const;

const specialVehicleBrands = new Map(
  ["BMW", "GMC", "BYD", "MG", "RAM"].map((brand) => [normalizeVehicleComparable(brand), brand]),
);

const specialVehicleModels = new Map(
  ["CR-V", "HR-V", "CX-5", "CX-30", "RAV4", "NP300", "BT-50", "F-150"].map((model) => [
    normalizeVehicleComparable(model),
    model,
  ]),
);

export function normalizeVehicleComparable(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function cleanVehicleText(value: string | null | undefined) {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");

  return cleaned.length > 0 ? cleaned : null;
}

function formatWord(value: string) {
  if (!value) {
    return value;
  }

  const normalized = normalizeVehicleComparable(value);
  const specialModel = specialVehicleModels.get(normalized);
  if (specialModel) {
    return specialModel;
  }

  const alphaNumericMatch = value.match(/^([a-z]+)([0-9][a-z0-9]*)$/i);
  if (alphaNumericMatch) {
    return `${alphaNumericMatch[1].toUpperCase()}${alphaNumericMatch[2].toUpperCase()}`;
  }

  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function formatVehicleText(value: string) {
  const specialModel = specialVehicleModels.get(normalizeVehicleComparable(value));
  if (specialModel) {
    return specialModel;
  }

  return value
    .split(" ")
    .map((word) => word.split("-").map(formatWord).join("-"))
    .join(" ");
}

export function normalizeVehicleBrand(value: string | null | undefined) {
  const cleaned = cleanVehicleText(value);
  if (!cleaned) {
    return null;
  }

  const specialBrand = specialVehicleBrands.get(normalizeVehicleComparable(cleaned));
  return specialBrand ?? formatVehicleText(cleaned);
}

export function normalizeVehicleModel(value: string | null | undefined) {
  const cleaned = cleanVehicleText(value);
  return cleaned ? formatVehicleText(cleaned) : null;
}

export function uniqueVehicleValues(values: Array<string | null | undefined>, kind: "brand" | "model") {
  const normalize = kind === "brand" ? normalizeVehicleBrand : normalizeVehicleModel;
  const unique = new Map<string, string>();

  values.forEach((value) => {
    const normalized = normalize(value);
    if (normalized) {
      unique.set(normalizeVehicleComparable(normalized), normalized);
    }
  });

  return Array.from(unique.values()).sort((left, right) => left.localeCompare(right, "es-HN"));
}
