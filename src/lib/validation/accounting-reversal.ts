import { z } from "zod";
import { isCivilDate } from "@/lib/civil-date";

export const accountingReversalSchema = z.object({
  entryId: z.string().uuid("La partida contable no es válida."),
  reason: z.string()
    .trim()
    .transform((value) => value.replace(/\s+/g, " "))
    .pipe(z.string().min(10, "El motivo de la reversión debe tener entre 10 y 500 caracteres.").max(500, "El motivo de la reversión debe tener entre 10 y 500 caracteres.")),
  effectiveDate: z.string().refine(isCivilDate, "Seleccione la fecha efectiva de la reversión."),
  requestKey: z.string().uuid("La solicitud de reversión no es válida. Vuelva a abrir el diálogo."),
  expectedVersion: z.number().int().positive("La versión de la partida no es válida."),
}).strict();

export type AccountingReversalValidatedInput = z.output<typeof accountingReversalSchema>;

export function firstAccountingReversalValidationMessage(error: z.ZodError) {
  return error.issues[0]?.message ?? "Revise los datos de la reversión.";
}
