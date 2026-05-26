const cloudinaryUploadMarker = "/image/upload/";

const cloudinaryTransformPrefixes = [
  "a_",
  "ar_",
  "b_",
  "c_",
  "dpr_",
  "e_",
  "f_",
  "fl_",
  "g_",
  "h_",
  "q_",
  "r_",
  "t_",
  "w_",
  "x_",
  "y_",
  "z_",
];

export function isCloudinaryImageUrl(url: string) {
  return url.includes("res.cloudinary.com") && url.includes(cloudinaryUploadMarker);
}

function isTransformationSegment(segment: string) {
  if (!segment.includes(",")) {
    return cloudinaryTransformPrefixes.some((prefix) => segment.startsWith(prefix));
  }

  return segment.split(",").every((part) => cloudinaryTransformPrefixes.some((prefix) => part.startsWith(prefix)));
}

function stripExistingTransformations(path: string) {
  const segments = path.split("/").filter(Boolean);

  while (segments.length > 0 && isTransformationSegment(segments[0])) {
    segments.shift();
  }

  return segments.join("/");
}

function cloudinaryImageUrl(url: string, transformation: string) {
  if (!isCloudinaryImageUrl(url)) {
    return url;
  }

  const [prefix, suffix] = url.split(cloudinaryUploadMarker);
  if (!prefix || !suffix) {
    return url;
  }

  const queryStart = suffix.indexOf("?");
  const sourcePath = queryStart >= 0 ? suffix.slice(0, queryStart) : suffix;
  const queryString = queryStart >= 0 ? suffix.slice(queryStart) : "";
  const cleanSourcePath = stripExistingTransformations(sourcePath);

  if (!cleanSourcePath) {
    return url;
  }

  return `${prefix}${cloudinaryUploadMarker}${transformation}/${cleanSourcePath}${queryString}`;
}

export function getProductThumbnailUrl(imageUrl: string) {
  return cloudinaryImageUrl(imageUrl, "f_auto,q_auto:eco,c_fill,g_auto,w_720,h_496,dpr_auto");
}

export function getProductImageUrl(imageUrl: string) {
  return cloudinaryImageUrl(imageUrl, "f_auto,q_auto,c_limit,w_1200,dpr_auto");
}

export function getProductZoomUrl(imageUrl: string) {
  return cloudinaryImageUrl(imageUrl, "f_auto,q_auto:good,c_limit,w_1600,dpr_auto");
}

export function getProductGalleryThumbnailUrl(imageUrl: string) {
  return cloudinaryImageUrl(imageUrl, "f_auto,q_auto:eco,c_fill,g_auto,w_300,h_214,dpr_auto");
}

export function getBannerImageUrl(imageUrl: string) {
  return cloudinaryImageUrl(imageUrl, "f_auto,q_auto:good,c_fill,g_auto,w_1400,h_760,dpr_auto");
}

export function getBannerPosterUrl(imageUrl: string) {
  return cloudinaryImageUrl(imageUrl, "f_auto,q_auto:eco,c_fill,g_auto,w_900,h_500,dpr_auto");
}

export function productImageUrl(url: string, size: "catalog" | "detail" | "thumbnail" | "zoom") {
  if (size === "catalog") {
    return getProductThumbnailUrl(url);
  }

  if (size === "thumbnail") {
    return getProductGalleryThumbnailUrl(url);
  }

  if (size === "zoom") {
    return getProductZoomUrl(url);
  }

  return getProductImageUrl(url);
}
