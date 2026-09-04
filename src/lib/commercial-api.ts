import { CommercialReportingServiceError } from "@/services/supabase/commercial-reporting.service";
import { CommercialValidationError } from "@/lib/validation/commercial-reporting";

export function commercialApiError(error: unknown) {
  if (error instanceof CommercialValidationError) return Response.json({ code:error.code,message:error.message },{status:400});
  if (error instanceof CommercialReportingServiceError) {
    const status=error.code.includes("ACCESS_DENIED")?403:error.code.includes("NOT_FOUND")?404:error.code.includes("CONFLICT")||error.code.includes("STALE")?409:400;
    return Response.json({code:error.code,message:error.message},{status});
  }
  console.error("commercial_api_error",error);
  return Response.json({code:"COMMERCIAL_OPERATION_FAILED",message:"No se pudo completar la operación."},{status:500});
}
