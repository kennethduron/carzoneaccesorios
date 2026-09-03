import { authorizeCommissionRequest } from "@/lib/auth/commission-request";
import { commissionListSchema } from "@/lib/validation/commissions";
import { CommissionServiceError, listCommissions } from "@/services/supabase/commissions.service";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  const auth=await authorizeCommissionRequest("commissions:read_all",true);if(auth.response)return auth.response;
  const parsed=commissionListSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if(!parsed.success)return Response.json({code:"COMMISSION_QUERY_INVALID",message:parsed.error.issues[0]?.message},{status:400});
  try{return Response.json(await listCommissions({...parsed.data,query:parsed.data.q}),{headers:{"Cache-Control":"private, no-store"}});}
  catch(error){return Response.json({code:error instanceof CommissionServiceError?error.code:"COMMISSION_LIST_FAILED",message:error instanceof Error?error.message:"No se pudieron cargar las comisiones."},{status:400});}
}
