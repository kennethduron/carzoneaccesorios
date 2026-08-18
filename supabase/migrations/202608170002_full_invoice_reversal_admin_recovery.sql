-- Allow the existing admin role to use the narrowly scoped recovery mode.
-- This migration changes only the function definition; it does not touch data.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare
  function_definition text;
  old_fragment constant text := 'if actor_role not in (''technical_owner'', ''business_owner'') then';
  new_fragment constant text := 'if actor_role not in (''technical_owner'', ''business_owner'', ''admin'') then';
  occurrence_count integer;
begin
  select pg_get_functiondef(
    'public.cancel_sale_invoice_v1(uuid,text,boolean,jsonb)'::regprocedure
  ) into strict function_definition;

  occurrence_count := (
    length(function_definition) - length(replace(function_definition, old_fragment, ''))
  ) / length(old_fragment);

  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'CANCEL_SALE_INVOICE_RECOVERY_ROLE_GATE_UNEXPECTED';
  end if;

  execute replace(function_definition, old_fragment, new_fragment);
end;
$$;

comment on function public.cancel_sale_invoice_v1(uuid, text, boolean, jsonb) is
  'Exactly-once fiscal and commercial sale reversal. Recovery mode is restricted to technical_owner, business_owner, and admin and is fail-closed against exact incident expectations.';

commit;
