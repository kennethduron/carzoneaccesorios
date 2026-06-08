create or replace view public.business_settings as
select *
from public.company_settings;

revoke all on public.business_settings from anon;
revoke all on public.business_settings from authenticated;
grant select on public.business_settings to service_role;

