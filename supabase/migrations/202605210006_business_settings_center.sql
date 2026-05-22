alter table public.company_settings
  add column if not exists notify_transfer_receipt_uploaded boolean not null default true,
  add column if not exists notify_customer_account_created boolean not null default true,
  add column if not exists notify_low_stock boolean not null default true,
  add column if not exists send_daily_activity_summary boolean not null default false,
  add column if not exists send_weekly_sales_summary boolean not null default false,
  add column if not exists crm_auto_followup_on_customer_created boolean not null default true,
  add column if not exists crm_auto_followup_after_purchase boolean not null default true,
  add column if not exists crm_show_inactive_customers boolean not null default false,
  add column if not exists crm_detect_duplicates boolean not null default true,
  add column if not exists crm_alert_overdue_followups boolean not null default true,
  add column if not exists wholesale_manual_approval boolean not null default true,
  add column if not exists wholesale_purchases_enabled boolean not null default true,
  add column if not exists wholesale_allow_repeat_without_minimum boolean not null default true,
  add column if not exists wholesale_auto_suspend_inactive boolean not null default false,
  add column if not exists allow_bank_transfer boolean not null default true,
  add column if not exists allow_cash_on_delivery boolean not null default true,
  add column if not exists bac_card_status text not null default 'pending',
  add column if not exists send_order_confirmation_email boolean not null default true,
  add column if not exists send_order_status_update_email boolean not null default true,
  add column if not exists require_bank_reference boolean not null default true,
  add column if not exists transfer_receipt_requirement text not null default 'optional',
  add column if not exists low_stock_alerts_enabled boolean not null default true,
  add column if not exists global_low_stock_threshold integer not null default 5,
  add column if not exists out_of_stock_catalog_mode text not null default 'show',
  add column if not exists stock_reservations_enabled boolean not null default true,
  add column if not exists stock_reservation_minutes integer not null default 2880,
  add column if not exists dashboard_cards jsonb not null default '{
    "sales_today": true,
    "pending_orders": true,
    "pending_payments": true,
    "low_inventory": true,
    "wholesale_requests": true,
    "customers_attention": true,
    "pending_invoices": true,
    "bac_alerts": true,
    "backup_cron_status": false
  }'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'company_settings_bac_card_status_check'
  ) then
    alter table public.company_settings
      add constraint company_settings_bac_card_status_check
      check (bac_card_status in ('hidden', 'pending', 'active'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'company_settings_transfer_receipt_requirement_check'
  ) then
    alter table public.company_settings
      add constraint company_settings_transfer_receipt_requirement_check
      check (transfer_receipt_requirement in ('disabled', 'optional', 'required'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'company_settings_out_of_stock_catalog_mode_check'
  ) then
    alter table public.company_settings
      add constraint company_settings_out_of_stock_catalog_mode_check
      check (out_of_stock_catalog_mode in ('show', 'hide'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'company_settings_global_low_stock_threshold_check'
  ) then
    alter table public.company_settings
      add constraint company_settings_global_low_stock_threshold_check
      check (global_low_stock_threshold >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'company_settings_stock_reservation_minutes_check'
  ) then
    alter table public.company_settings
      add constraint company_settings_stock_reservation_minutes_check
      check (stock_reservation_minutes between 15 and 10080);
  end if;
end $$;

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
  customer_service_hours,
  wholesale_purchases_enabled,
  wholesale_allow_repeat_without_minimum,
  allow_bank_transfer,
  allow_cash_on_delivery,
  bac_card_status,
  send_order_confirmation_email,
  send_order_status_update_email,
  require_bank_reference,
  transfer_receipt_requirement,
  out_of_stock_catalog_mode,
  stock_reservations_enabled
from public.company_settings
order by created_at asc
limit 1;

grant select on public.public_company_settings to anon, authenticated;

comment on column public.company_settings.dashboard_cards is 'Preferencias de tarjetas visibles en el dashboard operativo.';
comment on column public.company_settings.bac_card_status is 'Estado público de pago con tarjeta: hidden, pending o active.';
comment on column public.company_settings.transfer_receipt_requirement is 'Regla para comprobante de transferencia: disabled, optional o required.';
