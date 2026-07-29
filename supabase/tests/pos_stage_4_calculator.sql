\set ON_ERROR_STOP on
begin;
select plan(2);

do $$
declare
  standard jsonb;
  exempt jsonb;
  mixed jsonb;
  legacy jsonb;
begin
  standard := public.calculate_pos_draft_financials_v2('[{"quantity":2,"unit_price":115,"tax_category":"standard"}]', 0.15, 0, 0, 0, 'HNL');
  exempt := public.calculate_pos_draft_financials_v2('[{"quantity":1,"unit_price":100,"tax_category":"exempt"}]', 0.15, 0, 0, 0, 'HNL');
  mixed := public.calculate_pos_draft_financials_v2('[{"quantity":1,"unit_price":115,"tax_category":"standard"},{"quantity":1,"unit_price":100,"tax_category":"exempt"}]', 0.15, 0, 0, 0, 'HNL');
  legacy := public.calculate_sale_financials_v1('[{"quantity":2,"unit_price":115}]', 0.15, 0, 0, 0, 0, '[]', 10000, 3000, 120, 'store_immediate', 'retail', 'HNL');
  if (standard->>'total')::numeric <> 230 or (standard->>'taxable_base')::numeric <> 200 or (standard->>'tax_total')::numeric <> 30 then raise exception 'standard calculation mismatch: %', standard; end if;
  if (exempt->>'exempt_total')::numeric <> 100 or (exempt->>'tax_total')::numeric <> 0 then raise exception 'exempt calculation mismatch: %', exempt; end if;
  if (mixed->>'total')::numeric <> 215 or (mixed->>'taxable_base')::numeric <> 100 or (mixed->>'exempt_total')::numeric <> 100 or (mixed->>'tax_total')::numeric <> 15 then raise exception 'mixed calculation mismatch: %', mixed; end if;
  if (standard->>'total')::numeric <> (legacy->>'total_final')::numeric or (standard->>'taxable_base')::numeric <> (legacy->>'merchandise_taxable_base')::numeric or (standard->>'tax_total')::numeric <> (legacy->>'merchandise_included_tax')::numeric then raise exception 'v2 standard differs from v1: %, %', standard, legacy; end if;
end;
$$;
select pass('standard, exempt, mixed, rounding, and v1 compatibility');

do $$
begin
  if has_table_privilege('authenticated', 'public.pos_sale_drafts', 'insert')
    or has_table_privilege('authenticated', 'public.pos_sale_drafts', 'update')
    or has_table_privilege('authenticated', 'public.pos_sale_drafts', 'delete')
    or has_table_privilege('authenticated', 'public.pos_sale_draft_items', 'insert')
    or has_table_privilege('authenticated', 'public.pos_sale_draft_items', 'update')
    or has_table_privilege('authenticated', 'public.pos_sale_draft_items', 'delete')
  then raise exception 'authenticated retained direct draft writes'; end if;
end;
$$;
select pass('authenticated has no direct draft writes');

select * from finish();
rollback;
\echo 'POS Stage 4 fiscal calculator and grants: OK'
