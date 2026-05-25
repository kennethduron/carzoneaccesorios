export const reservedUsernames = new Set([
  "admin",
  "soporte",
  "root",
  "carzone",
  "mayorista",
  "facturas",
  "pedidos",
]);

export function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

export function validateUsername(value: string) {
  const username = normalizeUsername(value);

  if (username.length < 3 || username.length > 30) {
    return { ok: false as const, message: "El usuario debe tener entre 3 y 30 caracteres." };
  }

  if (!/^[a-z0-9._-]+$/.test(username)) {
    return {
      ok: false as const,
      message: "El usuario solo puede usar letras, numeros, punto, guion bajo o guion.",
    };
  }

  if (reservedUsernames.has(username)) {
    return { ok: false as const, message: "Este nombre de usuario está reservado. Elige otro." };
  }

  return { ok: true as const, username };
}
