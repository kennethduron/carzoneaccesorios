import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CartView } from "@/components/store/cart-view";

export default function CarritoPage() {
  return (
    <PublicStoreShell>
      <CartView />
    </PublicStoreShell>
  );
}
