import { PublicStoreShell } from "@/components/store/public-store-shell";
import { OrdersList } from "@/components/store/orders-list";
import { requireSession } from "@/lib/auth/session";
import { getCustomerOrdersPage } from "@/services/supabase/customer-account.service";

export const dynamic = "force-dynamic";

export default async function MisPedidosPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const profile = await requireSession();
  const params = await searchParams;
  const ordersPage = await getCustomerOrdersPage(profile.id, {
    page: Number(params.page ?? 1),
    pageSize: 20,
  });

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-5xl px-5 py-8">
        <p className="text-sm text-black/50">Cuenta de {profile.full_name || profile.email}</p>
        <h1 className="mt-2 text-4xl font-semibold">Mis pedidos</h1>
        <OrdersList orders={ordersPage.orders} page={ordersPage.page} pageSize={ordersPage.pageSize} total={ordersPage.total} />
      </section>
    </PublicStoreShell>
  );
}
