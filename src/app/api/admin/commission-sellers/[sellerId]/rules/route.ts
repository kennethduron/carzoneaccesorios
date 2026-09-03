import { authorizeCommissionRequest } from "@/lib/auth/commission-request";
import { verifySameOriginRequest } from "@/lib/http/same-origin-request";
import { ruleInputSchema } from "@/lib/validation/commissions";
import { CommissionServiceError,createCommissionRule } from "@/services/supabase/commissions.service";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{sellerId:string}>}){
  if(!verifySameOriginRequest(request).ok)return Response.json({code:"ORIGIN_DENIED",message:"Solicitud de origen no permitido."},{status:403});
  const auth=await authorizeCommissionRequest("commissions:rules:manage",true);if(auth.response)return auth.response;
  let body:unknown;try{body=await request.json();}catch{return Response.json({code:"INVALID_JSON",message:"Solicitud invalida."},{status:400});}
  const parsed=ruleInputSchema.safeParse({...body as object,sellerId:(await context.params).sellerId});
  if(!parsed.success)return Response.json({code:"COMMISSION_RULE_INVALID_VALUE",message:parsed.error.issues[0]?.message},{status:400});
  try{return Response.json(await createCommissionRule(parsed.data),{status:201});}
  catch(error){return Response.json({code:error instanceof CommissionServiceError?error.code:"COMMISSION_RULE_FAILED",message:error instanceof Error?error.message:"No se pudo crear la regla."},{status:400});}
}
