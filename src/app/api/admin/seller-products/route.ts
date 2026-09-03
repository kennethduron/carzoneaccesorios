import { authorizeCommissionRequest } from "@/lib/auth/commission-request";
import { CommissionServiceError,searchSellerProducts } from "@/services/supabase/commissions.service";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  const auth=await authorizeCommissionRequest("sales:seller_dashboard:read_own");if(auth.response)return auth.response;
  if(auth.profile?.role!=="vendedor")return Response.json({code:"SELLER_PRODUCT_ACCESS_DENIED",message:"Acceso denegado."},{status:403});
  const url=new URL(request.url);const rawLimit=Number(url.searchParams.get("limit")??15);const rawOffset=Number(url.searchParams.get("offset")??0);const limit=Number.isInteger(rawLimit)?Math.min(Math.max(rawLimit,1),20):15;const offset=Number.isInteger(rawOffset)?Math.min(Math.max(rawOffset,0),10000):0;
  try{return Response.json(await searchSellerProducts({query:(url.searchParams.get("q")??"").slice(0,120),limit,offset}),{headers:{"Cache-Control":"private, no-store"}});}
  catch(error){return Response.json({code:error instanceof CommissionServiceError?error.code:"SELLER_PRODUCT_SEARCH_FAILED",message:error instanceof Error?error.message:"No se pudieron cargar los productos."},{status:400});}
}
