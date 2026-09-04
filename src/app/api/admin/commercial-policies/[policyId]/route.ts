import { authorizeCommissionRequest } from "@/lib/auth/commission-request";
import { commercialApiError } from "@/lib/commercial-api";
import { deactivateCommissionPolicy, duplicateCommissionPolicy } from "@/services/supabase/commercial-reporting.service";
import { parseReason, parseUuid } from "@/lib/validation/commercial-reporting";

export async function POST(request:Request,{params}:{params:Promise<{policyId:string}>}){const auth=await authorizeCommissionRequest("commissions:policies:manage",true);if(auth.response)return auth.response;try{const {policyId}=await params;const body=await request.json() as Record<string,unknown>;if(body.action==="duplicate")return Response.json(await duplicateCommissionPolicy({requestKey:parseUuid(body.requestKey,"REQUEST_KEY_INVALID"),policyId:parseUuid(policyId),name:String(body.name??"")}));if(body.action==="deactivate")return Response.json(await deactivateCommissionPolicy(parseUuid(policyId),parseReason(body.reason)));return Response.json({code:"ACTION_INVALID",message:"Acción no válida."},{status:400})}catch(error){return commercialApiError(error)}}
