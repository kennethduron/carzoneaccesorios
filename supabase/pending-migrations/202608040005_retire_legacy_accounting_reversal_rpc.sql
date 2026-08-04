-- Contract step. DO NOT promote until every deployed caller uses reverse_journal_entry_v2.
begin;

create or replace function public.reverse_journal_entry(
  target_entry_id uuid,
  p_reversal_reason text,
  actor_ip text default null,
  actor_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  raise exception 'REVERSAL_EFFECTIVE_DATE_REQUIRED: use reverse_journal_entry_v2'
    using errcode = '22023';
end;
$function$;

revoke all on function public.reverse_journal_entry(uuid, text, text, text) from public, anon;
grant execute on function public.reverse_journal_entry(uuid, text, text, text) to authenticated;

comment on function public.reverse_journal_entry(uuid, text, text, text) is
  'Retired V1 contract. Always rejects because an explicit effective date is required.';

commit;
