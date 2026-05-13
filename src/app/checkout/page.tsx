import { PublicStoreShell } from "@/components/store/public-store-shell";
import { CheckoutView } from "@/components/store/checkout-view";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export default async function CheckoutPage() {
  const settings = await getPublicCompanySettings();

  return (
    <PublicStoreShell>
      <CheckoutView settings={settings} />
    </PublicStoreShell>
  );
}
