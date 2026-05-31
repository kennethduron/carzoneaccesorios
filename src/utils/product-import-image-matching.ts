export const allowedProductImportImageExtensions = ["jpg", "jpeg", "png", "webp"] as const;

type ProductImportImageExtension = (typeof allowedProductImportImageExtensions)[number];

export type ProductImportImageCandidate<T> = {
  file: T;
  path: string;
  fileName: string;
  baseName: string;
  extension: ProductImportImageExtension;
  normalizedFileName: string;
  normalizedBaseName: string;
  size: number;
  mimeType: string;
};

export type ProductImportImageIndex<T> = {
  images: Array<ProductImportImageCandidate<T>>;
  exactFileNames: Map<string, Array<ProductImportImageCandidate<T>>>;
  exactBaseNames: Map<string, Array<ProductImportImageCandidate<T>>>;
  normalizedFileNames: Map<string, Array<ProductImportImageCandidate<T>>>;
  normalizedBaseNames: Map<string, Array<ProductImportImageCandidate<T>>>;
};

export type ProductImportImageMatch<T> = {
  image: ProductImportImageCandidate<T>;
  method: string;
  warning: string | null;
};

const allowedExtensionSet = new Set<string>(allowedProductImportImageExtensions);

function cleanExactName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeProductImportImageName(value: string) {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._()-]+/gu, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitAllowedExtension(value: string) {
  const trimmed = value.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0) {
    return { baseName: trimmed, extension: null };
  }

  const extension = trimmed.slice(lastDot + 1).toLowerCase();
  return allowedExtensionSet.has(extension)
    ? { baseName: trimmed.slice(0, lastDot), extension: extension as ProductImportImageExtension }
    : { baseName: trimmed, extension: null };
}

export function validateProductImportZipPath(path: string) {
  const normalizedPath = path.replaceAll("\\", "/");
  const parts = normalizedPath.split("/");
  const fileName = parts.at(-1)?.trim() ?? "";
  const unsafePath =
    normalizedPath.startsWith("/") ||
    /^[a-z]:/i.test(normalizedPath) ||
    parts.some((part) => part === ".." || part.startsWith(".") || /[\u0000-\u001f]/.test(part));

  if (unsafePath || !fileName) {
    return { ok: false as const, message: `Se bloqueó una ruta peligrosa dentro del ZIP: ${path}` };
  }

  const { baseName, extension } = splitAllowedExtension(fileName);
  if (!extension) {
    return { ok: false as const, message: `Se rechazó ${path}: formato no permitido.` };
  }

  if (!baseName.trim() || !normalizeProductImportImageName(baseName)) {
    return { ok: false as const, message: `Se bloqueó un nombre de archivo peligroso dentro del ZIP: ${path}` };
  }

  return {
    ok: true as const,
    path: normalizedPath,
    fileName,
    baseName,
    extension,
  };
}

export function createProductImportImageCandidate<T>(
  path: string,
  file: T,
  size: number,
  mimeType: string,
) {
  const validation = validateProductImportZipPath(path);
  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true as const,
    image: {
      file,
      path: validation.path,
      fileName: validation.fileName,
      baseName: validation.baseName,
      extension: validation.extension,
      normalizedFileName: `${normalizeProductImportImageName(validation.baseName)}.${validation.extension}`,
      normalizedBaseName: normalizeProductImportImageName(validation.baseName),
      size,
      mimeType,
    } satisfies ProductImportImageCandidate<T>,
  };
}

function addToIndex<T>(
  map: Map<string, Array<ProductImportImageCandidate<T>>>,
  key: string,
  image: ProductImportImageCandidate<T>,
) {
  const images = map.get(key) ?? [];
  images.push(image);
  map.set(key, images);
}

export function createProductImportImageIndex<T>(
  images: Array<ProductImportImageCandidate<T>>,
): ProductImportImageIndex<T> {
  const index: ProductImportImageIndex<T> = {
    images,
    exactFileNames: new Map(),
    exactBaseNames: new Map(),
    normalizedFileNames: new Map(),
    normalizedBaseNames: new Map(),
  };

  for (const image of images) {
    addToIndex(index.exactFileNames, cleanExactName(image.fileName), image);
    addToIndex(index.exactBaseNames, cleanExactName(image.baseName), image);
    addToIndex(index.normalizedFileNames, image.normalizedFileName, image);
    addToIndex(index.normalizedBaseNames, image.normalizedBaseName, image);
  }

  return index;
}

function pathDepth(path: string) {
  return path.split("/").length - 1;
}

function selectClosestImage<T>(images: Array<ProductImportImageCandidate<T>>) {
  return [...images].sort((left, right) => {
    const depthDifference = pathDepth(left.path) - pathDepth(right.path);
    if (depthDifference !== 0) return depthDifference;

    const extensionDifference =
      allowedProductImportImageExtensions.indexOf(left.extension) -
      allowedProductImportImageExtensions.indexOf(right.extension);
    return extensionDifference !== 0 ? extensionDifference : left.path.localeCompare(right.path, "es");
  })[0];
}

function uniqueImages<T>(images: Array<ProductImportImageCandidate<T>>) {
  return Array.from(new Map(images.map((image) => [image.path, image])).values());
}

export function matchProductImportImage<T>(
  imageName: string,
  sku: string,
  index: ProductImportImageIndex<T>,
): ProductImportImageMatch<T> | null {
  const reference = splitAllowedExtension(imageName);
  const skuReference = splitAllowedExtension(sku);
  const methods: Array<{ label: string; images: Array<ProductImportImageCandidate<T>> }> = [];

  if (imageName.trim()) {
    if (reference.extension) {
      methods.push(
        { label: "nombre exacto con extensión", images: index.exactFileNames.get(cleanExactName(imageName)) ?? [] },
        {
          label: "nombre normalizado con extensión",
          images: index.normalizedFileNames.get(`${normalizeProductImportImageName(reference.baseName)}.${reference.extension}`) ?? [],
        },
      );
    } else {
      methods.push(
        { label: "nombre exacto sin extensión", images: index.exactBaseNames.get(cleanExactName(reference.baseName)) ?? [] },
        {
          label: "nombre normalizado sin extensión",
          images: index.normalizedBaseNames.get(normalizeProductImportImageName(reference.baseName)) ?? [],
        },
      );
    }
  }

  methods.push(
    { label: "SKU exacto", images: index.exactBaseNames.get(cleanExactName(skuReference.baseName)) ?? [] },
    { label: "SKU normalizado", images: index.normalizedBaseNames.get(normalizeProductImportImageName(skuReference.baseName)) ?? [] },
  );

  const possibleImages = uniqueImages(methods.flatMap((method) => method.images));
  const selectedMethod = methods.find((method) => method.images.length > 0);
  if (!selectedMethod) {
    return null;
  }

  const image = selectClosestImage(selectedMethod.images);
  const subfolderSuffix = pathDepth(image.path) > 0 ? " + subcarpeta" : "";

  return {
    image,
    method: `${selectedMethod.label}${subfolderSuffix}`,
    warning:
      possibleImages.length > 1
        ? "Hay más de una imagen posible para este producto. Se usó la coincidencia exacta más cercana."
        : null,
  };
}
