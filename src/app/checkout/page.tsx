import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CheckoutView } from "@/components/store/checkout-view";

export default function CheckoutPage() {
  return (
    <PublicStoreShell>
      <CheckoutView />
    </PublicStoreShell>
  );
}
