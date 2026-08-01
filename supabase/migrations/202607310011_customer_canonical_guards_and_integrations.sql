-- Operational guards and shared locking for canonical customer roots.

create or replace function public.guard_canonical_customer_reference_v1()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare root_id uuid;
begin
  if new.customer_id is null then return new; end if;
  if tg_op='UPDATE' and new.customer_id is not distinct from old.customer_id then return new; end if;
  root_id := public.resolve_customer_root_v1(new.customer_id);
  perform pg_advisory_xact_lock(hashtextextended('customer-root:' || root_id::text,0));
  if root_id <> new.customer_id then raise exception using errcode='23514', message='CUSTOMER_ALIAS_READ_ONLY'; end if;
  if not exists(select 1 from public.customers where id=root_id and active and status='active' and merged_into_customer_id is null) then raise exception using errcode='23514', message='CUSTOMER_CANONICAL_NOT_ACTIVE'; end if;
  return new;
end;
$$;

create trigger checkout_requests_v4_canonical_customer_guard before insert or update of customer_id on public.checkout_requests_v4 for each row execute function public.guard_canonical_customer_reference_v1();
create trigger pos_sale_drafts_canonical_customer_guard before insert or update of customer_id on public.pos_sale_drafts for each row execute function public.guard_canonical_customer_reference_v1();
create trigger accounts_receivable_canonical_customer_guard before insert or update of customer_id on public.accounts_receivable for each row execute function public.guard_canonical_customer_reference_v1();
create trigger accounts_receivable_payments_canonical_customer_guard before insert or update of customer_id on public.accounts_receivable_payments for each row execute function public.guard_canonical_customer_reference_v1();
create trigger crm_notes_canonical_customer_guard before insert or update of customer_id on public.crm_notes for each row execute function public.guard_canonical_customer_reference_v1();
create trigger crm_followups_canonical_customer_guard before insert or update of customer_id on public.crm_followups for each row execute function public.guard_canonical_customer_reference_v1();
create trigger customer_credit_accounts_canonical_customer_guard before insert or update of customer_id on public.customer_credit_accounts for each row execute function public.guard_canonical_customer_reference_v1();
create trigger wholesale_codes_canonical_customer_guard before insert or update of customer_id on public.wholesale_codes for each row execute function public.guard_canonical_customer_reference_v1();

create or replace function public.protect_merged_customer_updates_v1()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.merged_into_customer_id is not null and nullif(current_setting('app.customer_merge_operation',true),'') is null then
    raise exception using errcode='42501', message='CUSTOMER_ALIAS_READ_ONLY';
  end if;
  return new;
end;
$$;
create trigger customers_protect_merged_updates before update on public.customers for each row execute function public.protect_merged_customer_updates_v1();

create or replace function public.normalize_pos_customer_text_v1(raw_value text)
returns text language sql immutable parallel safe set search_path = public as $$ select public.normalize_customer_name_v1(raw_value); $$;
create or replace function public.normalize_pos_customer_email_v1(raw_value text)
returns text language sql immutable parallel safe set search_path = public as $$ select public.normalize_customer_email_v1(raw_value); $$;
create or replace function public.normalize_pos_customer_phone_v1(raw_value text)
returns text language sql immutable parallel safe set search_path = public as $$ select public.normalize_customer_phone_hn_v1(raw_value); $$;
create or replace function public.normalize_pos_customer_tax_id_v1(raw_value text)
returns text language sql immutable parallel safe set search_path = public as $$ select public.normalize_customer_tax_id_hn_v1(raw_value); $$;

create or replace function public.find_pos_customer_duplicate_v1(normalized_email text, normalized_phone text, normalized_tax_id text, excluded_customer_id uuid default null)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select c.id from public.customers c
  where c.merged_into_customer_id is null and c.active and c.status='active'
    and (excluded_customer_id is null or c.id <> public.resolve_customer_root_v1(excluded_customer_id))
    and (
      (public.normalize_customer_email_v1(normalized_email) is not null and public.normalize_customer_email_v1(c.email)=public.normalize_customer_email_v1(normalized_email)) or
      (public.normalize_customer_phone_hn_v1(normalized_phone) is not null and public.normalize_customer_phone_hn_v1(c.phone)=public.normalize_customer_phone_hn_v1(normalized_phone)) or
      (public.normalize_customer_tax_id_hn_v1(normalized_tax_id) is not null and public.normalize_customer_tax_id_hn_v1(c.tax_id)=public.normalize_customer_tax_id_hn_v1(normalized_tax_id))
    ) order by c.created_at,c.id limit 1;
$$;

create or replace function public.set_customer_feature_flag_v1(p_key text,p_enabled boolean,p_reason text)
returns public.customer_feature_flags language plpgsql security definer set search_path = public, pg_temp as $$
declare actor_id uuid:=auth.uid(); actor_role text:=public.current_actor_role(); saved public.customer_feature_flags%rowtype;
begin
  if actor_id is null or actor_role not in ('technical_owner','business_owner') or not public.has_permission('customers:merge') then raise exception using errcode='42501', message='CUSTOMER_FEATURE_FLAG_FORBIDDEN'; end if;
  if p_key not in ('customer_merge_execution_v1','customer_duplicate_prevention_v1') or char_length(trim(coalesce(p_reason,''))) not between 10 and 500 then raise exception using errcode='22023', message='CUSTOMER_FEATURE_FLAG_INVALID'; end if;
  update public.customer_feature_flags set enabled=p_enabled,version=version+1,reason=trim(p_reason),enabled_at=case when p_enabled then now() else null end,updated_by=actor_id,updated_at=now() where key=p_key returning * into saved;
  perform public.write_audit_log('customer_feature_flags',null,'customer.feature_flag_changed',null,jsonb_build_object('key',p_key,'enabled',p_enabled,'version',saved.version,'reason',trim(p_reason)));
  return saved;
end;
$$;

create or replace view public.customer_canonical_directory_v1 with (security_invoker=true) as
select c.*, (select count(*)-1 from public.get_customer_family_ids_v1(c.id))::integer as merged_alias_count
from public.customers c where c.merged_into_customer_id is null;

revoke all on function public.set_customer_feature_flag_v1(text,boolean,text) from public,anon;
grant execute on function public.set_customer_feature_flag_v1(text,boolean,text) to authenticated,service_role;
revoke all on public.customer_canonical_directory_v1 from public,anon;
grant select on public.customer_canonical_directory_v1 to authenticated,service_role;
