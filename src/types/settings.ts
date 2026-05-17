export type CommerceSettings = {
  free_shipping_threshold: number;
  standard_shipping_fee: number;
  cash_on_delivery_percentage: number;
  enable_cash_on_delivery_fee: boolean;
  first_wholesale_minimum: number;
};

export type SocialSettings = {
  facebook_url: string;
  instagram_url: string;
  whatsapp_url: string;
  tiktok_url: string;
  youtube_url: string;
  website_url: string;
};

export type BusinessContactSettings = {
  trade_name: string;
  legal_business_name: string;
  business_rtn: string;
  business_address: string;
  customer_service_phone: string;
  customer_service_email: string;
  customer_service_whatsapp: string;
  customer_service_hours: string;
};

export type PublicCompanySettings = CommerceSettings &
  SocialSettings & {
    company_name: string;
    currency: string;
    tax_rate: number;
    logo_url: string | null;
  } & BusinessContactSettings;

export type HolidayBanner = {
  id: string;
  holiday_key: string | null;
  title: string;
  message: string;
  image_url: string | null;
  start_date: string;
  end_date: string;
  is_active: boolean;
  priority: number;
  button_text: string | null;
  button_url: string | null;
  created_at: string;
  updated_at: string;
};

export type HolidayBannerInput = {
  id?: string;
  title: string;
  message: string;
  image_url: string;
  start_date: string;
  end_date: string;
  is_active: boolean;
  priority: number;
  button_text: string;
  button_url: string;
};
