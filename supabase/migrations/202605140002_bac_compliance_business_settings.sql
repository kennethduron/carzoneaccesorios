alter table public.company_settings
  add column if not exists trade_name text not null default 'Car Zone Accesorios',
  add column if not exists legal_business_name text,
  add column if not exists business_rtn text,
  add column if not exists business_address text,
  add column if not exists customer_service_phone text,
  add column if not exists customer_service_email text,
  add column if not exists customer_service_whatsapp text,
  add column if not exists customer_service_hours text not null default 'Lunes a sábado, 8:00 a.m. a 6:00 p.m.';

create or replace view public.public_company_settings as
select
  company_name,
  currency,
  tax_rate,
  logo_url,
  free_shipping_threshold,
  standard_shipping_fee,
  cash_on_delivery_percentage,
  enable_cash_on_delivery_fee,
  first_wholesale_minimum,
  facebook_url,
  instagram_url,
  whatsapp_url,
  tiktok_url,
  youtube_url,
  website_url,
  trade_name,
  legal_business_name,
  business_rtn,
  business_address,
  customer_service_phone,
  customer_service_email,
  customer_service_whatsapp,
  customer_service_hours
from public.company_settings
order by created_at asc
limit 1;

grant select on public.public_company_settings to anon, authenticated;

comment on column public.company_settings.trade_name is 'Nombre comercial público del negocio.';
comment on column public.company_settings.legal_business_name is 'Razón social del comercio para documentación bancaria y fiscal.';
comment on column public.company_settings.business_rtn is 'RTN público del comercio, si aplica.';
comment on column public.company_settings.customer_service_email is 'Correo público de servicio al cliente; no usar para notificaciones internas.';
