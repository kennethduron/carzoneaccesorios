import { authorizeCommissionRequest } from "@/lib/auth/commission-request";
import { CommissionServiceError, getMyCommission } from "@/services/supabase/commissions.service";
export const dynamic="force-dynamic";
export async function GET(_request:Request,context:{params:Promise<{entryId:string}>}){
  const auth=await authorizeCommissionRequest("commissions:read_own");if(auth.response)return auth.response;
  try{return Response.json(await getMyCommission((await context.params).entryId),{headers:{"Cache-Control":"private, no-store"}});}
  catch(error){const code=error instanceof CommissionServiceError?error.code:"COMMISSION_DETAIL_FAILED";return Response.json({code,message:error instanceof Error?error.message:"No se pudo cargar la comision."},{status:code==="COMMISSION_NOT_FOUND"?404:400});}
}
