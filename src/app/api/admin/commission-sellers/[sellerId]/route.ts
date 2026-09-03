import { authorizeCommissionRequest } from "@/lib/auth/commission-request";
import { CommissionServiceError,getSellerCommercialProfile } from "@/services/supabase/commissions.service";
export const dynamic="force-dynamic";
export async function GET(_request:Request,context:{params:Promise<{sellerId:string}>}){
  const auth=await authorizeCommissionRequest("commissions:read_all",true);if(auth.response)return auth.response;
  try{return Response.json(await getSellerCommercialProfile((await context.params).sellerId),{headers:{"Cache-Control":"private, no-store"}});}
  catch(error){const code=error instanceof CommissionServiceError?error.code:"COMMISSION_SELLER_FAILED";return Response.json({code,message:error instanceof Error?error.message:"No se pudo cargar el vendedor."},{status:code==="COMMISSION_SELLER_NOT_FOUND"?404:400});}
}
