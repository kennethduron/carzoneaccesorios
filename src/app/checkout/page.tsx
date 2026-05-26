import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CheckoutView } from "@/components/store/checkout-view";
import { getCheckoutAccountAction } from "@/app/checkout/actions";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export default async function CheckoutPage() {
  const [settings, account] = await Promise.all([getPublicCompanySettings(), getCheckoutAccountAction()]);

  return (
    <PublicStoreShell>
      <CheckoutView settings={settings} initialAccount={account} />
    </PublicStoreShell>
  );
}
