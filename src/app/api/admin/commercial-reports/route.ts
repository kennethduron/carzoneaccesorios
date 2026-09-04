import { authorizeCommissionRequest } from "@/lib/auth/commission-request";
import { commercialApiError } from "@/lib/commercial-api";
import { normalizeCommercialFilters } from "@/lib/validation/commercial-reporting";
import { getCommercialDashboard } from "@/services/supabase/commercial-reporting.service";

export async function GET(request:Request){const auth=await authorizeCommissionRequest("commercial:reports:read",true);if(auth.response)return auth.response;try{const url=new URL(request.url);const filters=normalizeCommercialFilters(Object.fromEntries(url.searchParams));const limit=Math.min(100,Math.max(1,Number(url.searchParams.get("limit")??20)));const offset=Math.max(0,Number(url.searchParams.get("offset")??0));return Response.json(await getCommercialDashboard(filters,limit,offset),{headers:{"Cache-Control":"private, no-store"}})}catch(error){return commercialApiError(error)}}
