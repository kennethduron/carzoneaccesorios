import { z } from 'zod';
import { authorizePosCustomerRequest } from '@/lib/auth/pos-customer-request';
import { PosCustomerServiceError, suggestPosCustomerDuplicates } from '@/services/supabase/pos-customer.service';

export const dynamic = 'force-dynamic';

const nullable = (maximum: number) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() ? value.trim() : null,
  z.string().max(maximum).nullable(),
);

const schema = z.object({
  contactName: z.string().trim().max(160),
  businessName: nullable(160),
  email: nullable(254),
  phone: nullable(40),
  taxId: nullable(40),
}).strict();

export async function POST(request: Request) {
  const auth = await authorizePosCustomerRequest('pos:customers:create');
  if (auth.response) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ message: 'La busqueda contiene datos invalidos.' }, { status: 400 });
  }
  const hasSufficientInput = parsed.data.contactName.length >= 3
    || Boolean(parsed.data.businessName && parsed.data.businessName.length >= 3)
    || Boolean(parsed.data.email)
    || Boolean(parsed.data.phone && parsed.data.phone.replace(/\D/g, '').length >= 8)
    || Boolean(parsed.data.taxId && parsed.data.taxId.replace(/\D/g, '').length >= 14);
  if (!hasSufficientInput) {
    return Response.json({ results: [], hasStrongMatch: false }, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  try {
    return Response.json(
      await suggestPosCustomerDuplicates(parsed.data),
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    const denied = error instanceof PosCustomerServiceError && error.code === '42501';
    return Response.json(
      { message: denied ? 'Acceso denegado.' : 'No se pudieron buscar posibles clientes existentes.' },
      { status: denied ? 403 : 500 },
    );
  }
}
