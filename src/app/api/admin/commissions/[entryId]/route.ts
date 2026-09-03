import { authorizeCommissionRequest } from "@/lib/auth/commission-request";
import { verifySameOriginRequest } from "@/lib/http/same-origin-request";
import { adjustmentInputSchema } from "@/lib/validation/commissions";
import { adjustCommission,CommissionServiceError,getCommissionDetail } from "@/services/supabase/commissions.service";
export const dynamic="force-dynamic";
export async function GET(_request:Request,context:{params:Promise<{entryId:string}>}){
  const auth=await authorizeCommissionRequest("commissions:read_all",true);if(auth.response)return auth.response;
  try{return Response.json(await getCommissionDetail((await context.params).entryId),{headers:{"Cache-Control":"private, no-store"}});}
  catch(error){const code=error instanceof CommissionServiceError?error.code:"COMMISSION_DETAIL_FAILED";return Response.json({code,message:error instanceof Error?error.message:"No se pudo cargar la comision."},{status:code==="COMMISSION_NOT_FOUND"?404:400});}
}
export async function PATCH(request:Request,context:{params:Promise<{entryId:string}>}){
  if(!verifySameOriginRequest(request).ok)return Response.json({code:"ORIGIN_DENIED",message:"Solicitud de origen no permitido."},{status:403});
  const auth=await authorizeCommissionRequest("commissions:adjust",true);if(auth.response)return auth.response;
  let body:unknown;try{body=await request.json();}catch{return Response.json({code:"INVALID_JSON",message:"Solicitud invalida."},{status:400});}
  const parsed=adjustmentInputSchema.safeParse({...body as object,entryId:(await context.params).entryId});
  if(!parsed.success)return Response.json({code:"COMMISSION_ADJUSTMENT_INVALID",message:parsed.error.issues[0]?.message},{status:400});
  try{return Response.json(await adjustCommission(parsed.data));}
  catch(error){return Response.json({code:error instanceof CommissionServiceError?error.code:"COMMISSION_ADJUSTMENT_FAILED",message:error instanceof Error?error.message:"No se pudo registrar el ajuste."},{status:400});}
}
