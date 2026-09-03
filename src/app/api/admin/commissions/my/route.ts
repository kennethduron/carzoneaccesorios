import { authorizeCommissionRequest } from "@/lib/auth/commission-request";
import { commissionListSchema } from "@/lib/validation/commissions";
import { CommissionServiceError, listMyCommissions } from "@/services/supabase/commissions.service";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await authorizeCommissionRequest("commissions:read_own"); if (auth.response) return auth.response;
  const parsed=commissionListSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if(!parsed.success)return Response.json({code:"COMMISSION_QUERY_INVALID",message:parsed.error.issues[0]?.message},{status:400});
  if(!parsed.data.from||!parsed.data.to)return Response.json({code:"COMMISSION_DATE_RANGE_INVALID",message:"Selecciona el rango de fechas."},{status:400});
  try{return Response.json(await listMyCommissions({...parsed.data,query:parsed.data.q,from:parsed.data.from,to:parsed.data.to}),{headers:{"Cache-Control":"private, no-store"}});}
  catch(error){return Response.json({code:error instanceof CommissionServiceError?error.code:"COMMISSION_LIST_FAILED",message:error instanceof Error?error.message:"No se pudieron cargar las comisiones."},{status:400});}
}
