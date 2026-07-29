import { z } from "zod";
import { normalizeAuthEmail, normalizeAuthPhone, normalizeAuthText } from "@/lib/auth/profile-sync";

export const publicRegistrationSchema = z.object({
  fullName: z
    .string()
    .transform(normalizeAuthText)
    .pipe(z.string().min(3, "Ingresa tu nombre completo.").max(160, "El nombre es demasiado largo.")),
  username: z.string().trim().min(1, "Ingresa un nombre de usuario.").max(30, "El nombre de usuario es demasiado largo."),
  email: z
    .string()
    .transform(normalizeAuthEmail)
    .pipe(z.string().email("Ingresa un correo electrónico válido.").max(254, "El correo electrónico es demasiado largo.")),
  phone: z
    .string()
    .transform(normalizeAuthPhone)
    .pipe(z.string().min(8, "Ingresa un número de teléfono válido.").max(15, "Ingresa un número de teléfono válido.")),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres.").max(128, "La contraseña es demasiado larga."),
  nextPath: z.string().optional(),
});

export type PublicRegistrationInput = z.input<typeof publicRegistrationSchema>;
