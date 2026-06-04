import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, value] = match;
    process.env[key] ||= value.replace(/^["']|["']$/g, "");
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

loadEnvFile(".env.local");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const suffix = randomUUID();
const resources = [];
const bannerFolder = "car-zone/banners";

function signParams(mediaType, publicId) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params = {
    timestamp,
    folder: bannerFolder,
    public_id: publicId,
    overwrite: "false",
    invalidate: "true",
    context: "source=holiday_banner_audit|actor_id=script|original_bytes=0",
  };

  if (mediaType === "image") {
    params.format = "webp";
  } else {
    params.eager = "w_1600,c_limit,q_auto,f_mp4|w_900,h_500,c_fill,g_auto,q_auto,f_jpg,so_0";
    params.eager_async = "false";
  }

  return {
    params,
    signature: cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET),
    uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${mediaType}/upload`,
  };
}

async function directUpload(mediaType, publicId, fileValue) {
  const signed = signParams(mediaType, publicId);
  const formData = new FormData();
  formData.set("file", fileValue);
  formData.set("api_key", process.env.CLOUDINARY_API_KEY);
  formData.set("signature", signed.signature);

  for (const [key, value] of Object.entries(signed.params)) {
    formData.set(key, value);
  }

  const response = await fetch(signed.uploadUrl, {
    method: "POST",
    body: formData,
  });
  const payload = await response.json();

  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Cloudinary direct upload failed with ${response.status}`);
  }

  return payload;
}

async function destroy(publicId, resourceType) {
  if (!publicId) {
    return;
  }

  const result = await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    invalidate: true,
  });
  const resultValue = typeof result === "object" && result ? String(result.result ?? "") : "";
  assert(["ok", "not found"].includes(resultValue), `Cloudinary no confirmo delete ${resourceType}: ${resultValue}`);
}

try {
  const imageBlob = new Blob([readFileSync("tmp/banner-home-desktop.png")], { type: "image/png" });
  const imageResult = await directUpload("image", `audit-image-${suffix}`, imageBlob);
  resources.push({ publicId: imageResult.public_id, resourceType: "image" });
  assert(imageResult.secure_url && imageResult.public_id, "Cloudinary no devolvio URL/public_id para imagen.");

  const videoResult = await directUpload("video", `audit-video-${suffix}`, "https://res.cloudinary.com/demo/video/upload/dog.mp4");
  resources.push({ publicId: videoResult.public_id, resourceType: "video" });
  assert(videoResult.secure_url && videoResult.public_id, "Cloudinary no devolvio URL/public_id para video.");
  assert(Number(videoResult.duration ?? 0) <= 60, "El video remoto de auditoria excede 60 segundos.");

  console.log("OK cloudinary direct banner upload/delete");
} finally {
  for (const resource of resources.reverse()) {
    await destroy(resource.publicId, resource.resourceType);
  }
}
