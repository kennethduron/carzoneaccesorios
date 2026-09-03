import { authorizeCommissionRequest } from "@/lib/auth/commission-request";
import { CommissionServiceError,listCommissionSellers } from "@/services/supabase/commissions.service";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  const auth=await authorizeCommissionRequest("commissions:read_all",true);if(auth.response)return auth.response;
  const url=new URL(request.url);const rawLimit=Number(url.searchParams.get("limit")??20);const rawOffset=Number(url.searchParams.get("offset")??0);const limit=Number.isInteger(rawLimit)?Math.min(Math.max(rawLimit,1),50):20;const offset=Number.isInteger(rawOffset)?Math.min(Math.max(rawOffset,0),10000):0;
  try{return Response.json(await listCommissionSellers({query:(url.searchParams.get("q")??"").slice(0,120),active:url.searchParams.get("active")??"all",limit,offset}),{headers:{"Cache-Control":"private, no-store"}});}
  catch(error){return Response.json({code:error instanceof CommissionServiceError?error.code:"COMMISSION_SELLERS_FAILED",message:error instanceof Error?error.message:"No se pudieron cargar los vendedores."},{status:400});}
}
