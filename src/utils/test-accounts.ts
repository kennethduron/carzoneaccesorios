const reservedTestDomains = new Set([
  "example.com",
  "example.net",
  "example.org",
  "test.com",
  "test.local",
  "mailinator.com",
  "yopmail.com",
]);

export function normalizeAccountEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isSafeTestAccountEmail(email: string) {
  const normalized = normalizeAccountEmail(email);
  const [localPart, domain] = normalized.split("@");

  if (!localPart || !domain) {
    return false;
  }

  return (
    reservedTestDomains.has(domain) ||
    localPart.includes("test") ||
    localPart.includes("prueba") ||
    localPart.includes("testing") ||
    localPart.includes("qa")
  );
}
