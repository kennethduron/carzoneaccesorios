const cloudinaryUploadMarker = "/image/upload/";

function cloudinaryImageUrl(url: string, transformation: string) {
  if (!url.includes("res.cloudinary.com") || !url.includes(cloudinaryUploadMarker)) {
    return url;
  }

  const [prefix, suffix] = url.split(cloudinaryUploadMarker);
  if (!prefix || !suffix) {
    return url;
  }

  const firstSlashIndex = suffix.indexOf("/");
  const sourcePath = suffix.startsWith("f_auto,") && firstSlashIndex > -1 ? suffix.slice(firstSlashIndex + 1) : suffix;

  return `${prefix}${cloudinaryUploadMarker}${transformation}/${sourcePath}`;
}

export function productImageUrl(url: string, size: "catalog" | "detail" | "thumbnail" | "zoom") {
  if (size === "catalog") {
    return cloudinaryImageUrl(url, "f_auto,q_auto:eco,c_fill,g_auto,w_520,h_360,dpr_auto");
  }

  if (size === "thumbnail") {
    return cloudinaryImageUrl(url, "f_auto,q_auto:eco,c_fill,g_auto,w_220,h_150,dpr_auto");
  }

  if (size === "zoom") {
    return cloudinaryImageUrl(url, "f_auto,q_auto,c_limit,w_1800,h_1400,dpr_auto");
  }

  return cloudinaryImageUrl(url, "f_auto,q_auto,c_limit,w_1400,h_1000,dpr_auto");
}
