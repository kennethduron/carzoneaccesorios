import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const actions = read("src/app/admin/banners/actions.ts");
const manager = read("src/components/admin/holiday-banners-manager.tsx");
const popup = read("src/components/store/holiday-banner-popup.tsx");
const page = read("src/app/admin/banners/page.tsx");
const signatureRoute = read("src/app/api/admin/banners/cloudinary-signature/route.ts");
const service = read("src/services/supabase/holiday-banners.service.ts");
const rlsMigration = read("supabase/migrations/202605210005_business_owner_user_management.sql");

assert(actions.includes('requirePermission("commercial_settings:manage")'), "Las acciones de banners deben requerir commercial_settings:manage.");
assert(page.includes('requirePermission("commercial_settings:manage")'), "La pagina /admin/banners debe requerir commercial_settings:manage.");
assert(rlsMigration.includes("public.has_permission('commercial_settings:manage')"), "RLS debe permitir roles con commercial_settings:manage.");
assert(signatureRoute.includes("getSessionProfile()"), "El endpoint de firma debe exigir sesion.");
assert(signatureRoute.includes('"commercial_settings:manage"'), "El endpoint de firma debe exigir permiso de banners.");
assert(signatureRoute.includes("api_sign_request"), "El endpoint debe generar firma Cloudinary server-side.");
assert(signatureRoute.includes('folder: bannerFolder'), "La firma debe fijar la carpeta autorizada.");
assert(signatureRoute.includes("CLOUDINARY_API_SECRET") && !manager.includes("CLOUDINARY_API_SECRET"), "El secret de Cloudinary solo debe usarse en servidor.");
assert(!signatureRoute.includes("params.format = \"webp\""), "La firma no debe convertir la imagen original a WEBP antes de guardar.");

assert(signatureRoute.includes('const allowedVideoTypes = new Set(["video/mp4", "video/webm"])'), "Debe aceptar MIME MP4 y WEBM.");
assert(actions.includes('const allowedVideoExtensions = new Set(["mp4", "webm"])'), "Debe validar extensiones MP4 y WEBM.");
assert(actions.includes("const videoMaxBytes = 25 * 1024 * 1024"), "Debe limitar videos a 25 MB.");
assert(actions.includes("const videoMaxDurationSeconds = 60"), "Debe limitar videos a 60 segundos.");
assert(actions.includes('"Solo se permiten videos MP4 o WEBM."'), "Debe mostrar error claro de formato de video.");
assert(actions.includes('"El video supera 25 MB."'), "Debe mostrar error claro de tamano de video.");
assert(actions.includes('"El video supera 60 segundos."'), "Debe mostrar error claro de duracion de video.");
assert(actions.includes('resource_type: "video"'), "Cloudinary debe subir videos como resource_type video.");
assert(actions.includes("holiday_banner_media_replaced"), "Debe borrar el archivo anterior cuando se reemplaza.");
assert(actions.includes("holiday_banner_deleted"), "Debe borrar el archivo al eliminar banner.");
assert(actions.includes('cloudinary.api.resources({ resource_type: "image"') && actions.includes('cloudinary.api.resources({ resource_type: "video"'), "La limpieza debe revisar imagenes y videos.");
assert(actions.includes('defaultBannerButtonUrl = "/catalogo"'), "El servidor debe aplicar /catalogo por defecto.");
assert(actions.includes("createHolidayBannerMediaTokenAction"), "Debe tokenizar metadata de Cloudinary antes de guardar.");
assert(actions.includes("verifiedCloudinaryResource"), "Debe verificar el recurso real en Cloudinary.");
assert(actions.includes("assertBannerMediaExists"), "Debe verificar que el archivo siga existiendo antes de guardar.");
assert(actions.includes("assertBannerPriorityAvailable"), "Debe bloquear prioridades duplicadas por ubicacion y rango.");
assert(actions.includes("Ya existe un banner activo con esta prioridad para ese rango de fechas"), "Debe mostrar error claro de prioridad duplicada.");
assert(actions.includes("holiday_banner_direct_upload_rejected"), "Debe limpiar uploads directos rechazados.");
assert(!actions.includes("upload_stream("), "El archivo no debe subirse por Server Action con upload_stream.");

assert(manager.includes("selectMediaFile") && manager.includes("uploadSelectedMedia"), "El formulario debe conservar el archivo seleccionado y subirlo al guardar.");
assert(manager.includes("/api/admin/banners/cloudinary-signature"), "El formulario debe pedir firma segura al backend.");
assert(manager.includes("uploadFileToCloudinary"), "El formulario debe subir directo a Cloudinary.");
assert(!manager.includes("onChange={(event) => uploadMedia"), "El input no debe depender de una subida inmediata perdida antes del submit.");
assert(!manager.includes("uploadHolidayBannerMediaAction"), "El cliente no debe mandar el archivo a una Server Action.");
assert(manager.includes("URL.createObjectURL(file)"), "El preview debe usar el archivo local seleccionado.");
assert(manager.includes("Archivo listo para guardar"), "Debe indicar que el archivo seleccionado se subira al guardar.");
assert(manager.includes("Recomendado: /catalogo"), "Debe explicar la URL recomendada del boton.");
assert(manager.includes("Banner principal: aparece como el banner mas importante"), "Debe explicar Principal.");
assert(manager.includes("Banner secundario: aparece como promocion adicional"), "Debe explicar Secundario.");
assert(manager.includes("deleteUploadedHolidayBannerMediaAction(prepared.uploadedToken)"), "Debe limpiar el upload nuevo si el guardado falla.");
assert(manager.includes("clearUploadedMediaReferences(prepared.uploadedToken)"), "Debe quitar referencias locales si se borra un upload tras fallo de guardado.");
assert(manager.includes("1 aparece primero. 5 aparece despues"), "Debe explicar el orden de prioridad.");

assert(popup.includes("autoPlay") && popup.includes("muted") && popup.includes("playsInline"), "El home debe renderizar video con autoplay seguro.");
assert(popup.includes('preload="metadata"'), "El home debe cargar solo metadata del video.");
assert(popup.includes("Activar sonido") && popup.includes("Silenciar"), "El popup debe permitir activar y silenciar sonido manualmente.");
assert(popup.includes("video.muted = false") && popup.includes("await video.play()"), "El sonido debe activarse solo por accion del usuario.");
assert(popup.includes("onEnded={advanceBanner}"), "El carrusel debe avanzar cuando termina el video.");
assert(popup.includes("loop={activeBanners.length < 2}"), "El video no debe quedar en loop infinito cuando hay carrusel.");
assert(popup.includes("No se pudo cargar la imagen de este banner."), "El popup debe mostrar fallback claro si una imagen falta.");

assert(service.includes('.order("priority", { ascending: true })'), "Los banners activos deben ordenarse con prioridad 1 primero.");

console.log("OK holiday banners structure");
