-- Keep the private technical service account aligned in existing environments.

alter table public.technical_alert_settings
  alter column service_account_email set default 'carzonetech0@gmail.com';

do $$
declare
  previous_email text;
begin
  select service_account_email
  into previous_email
  from public.technical_alert_settings
  where id = true;

  update public.technical_alert_settings
  set service_account_email = 'carzonetech0@gmail.com',
      updated_at = now()
  where id = true
    and service_account_email is distinct from 'carzonetech0@gmail.com';

  if found then
    insert into public.audit_logs (
      actor_role,
      table_name,
      record_id,
      action,
      old_data,
      new_data
    )
    values (
      'system_migration',
      'technical_alert_settings',
      null,
      'technical_service_account.updated',
      jsonb_build_object(
        'service_account_email', previous_email,
        'section', 'technical_services'
      ),
      jsonb_build_object(
        'service_account_email', 'carzonetech0@gmail.com',
        'section', 'technical_services',
        'result', 'updated'
      )
    );
  end if;
end;
$$;
