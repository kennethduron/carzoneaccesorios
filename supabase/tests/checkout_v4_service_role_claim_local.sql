\set ON_ERROR_STOP on
begin;
select plan(4);

select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  public.set_checkout_feature_flag_v1(
    true,
    'pgTAP service-role claim compatibility activation'
  )->>'enabled',
  'true',
  'current PostgREST service-role claims can activate Checkout V4 canonically'
);

select lives_ok(
  $$select public.cleanup_checkout_v4_retention_v1()$$,
  'current PostgREST service-role claims can run Checkout V4 retention'
);

select set_config('request.jwt.claims', '{"role":"anon"}', true);

select throws_ok(
  $$select public.set_checkout_feature_flag_v1(false, 'anonymous callers remain forbidden')$$,
  '42501',
  'CHECKOUT_FEATURE_FLAG_FORBIDDEN',
  'anonymous claims cannot change the Checkout V4 feature flag'
);

select throws_ok(
  $$select public.cleanup_checkout_v4_retention_v1()$$,
  '42501',
  'CHECKOUT_RETENTION_FORBIDDEN',
  'anonymous claims cannot run Checkout V4 retention'
);

select * from finish();
rollback;
\echo 'Checkout V4 service-role claim compatibility: OK'
