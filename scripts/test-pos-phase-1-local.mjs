import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const container = "supabase_db_car-zone-accesorios";
const actorIds = {
  technical_owner: "91000000-0000-4000-8000-000000000001",
  business_owner: "91000000-0000-4000-8000-000000000002",
  admin: "91000000-0000-4000-8000-000000000003",
  contadora: "91000000-0000-4000-8000-000000000004",
  vendedor: "91000000-0000-4000-8000-000000000005",
  bodega: "91000000-0000-4000-8000-000000000006",
  soporte: "91000000-0000-4000-8000-000000000007",
  cliente: "91000000-0000-4000-8000-000000000008",
};
const actorList = Object.values(actorIds).map((value) => `'${value}'`).join(",");
const operation = "pos_test_foundation";
const requestKey = "92000000-0000-4000-8000-000000000001";
const failedKey = "92000000-0000-4000-8000-000000000002";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

const args = ["exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"];

function runSql(sql, { expectedFailure } = {}) {
  const result = spawnSync("docker", args, { input: sql, encoding: "utf8", windowsHide: true });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (expectedFailure) {
    assert.notEqual(result.status, 0, `Expected SQL failure but command passed: ${output}`);
    assert.match(output, expectedFailure);
    return output;
  }
  assert.equal(result.status, 0, output);
  return (result.stdout ?? "").trim();
}

function runSqlAsync(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${stdout}${stderr}`)));
    child.stdin.end(sql);
  });
}

const withActor = (actorId, statement) => `
begin;
select set_config('request.jwt.claim.sub', '${actorId}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
${statement}
commit;
`;

const cleanupSql = `
delete from public.audit_logs
where user_id in (${actorList})
   or (table_name = 'pos_idempotency_requests' and action like 'pos.idempotency.%');
delete from public.pos_idempotency_requests where actor_id in (${actorList}) or operation = '${operation}';
delete from auth.users where id in (${actorList});
`;

try {
  runSql(cleanupSql);
  const authRows = Object.entries(actorIds).map(([role, id]) => `
    ('00000000-0000-0000-0000-000000000000', '${id}', 'authenticated', 'authenticated',
     'pos_test_${role}@example.invalid', '', now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('full_name', 'POS_TEST_${role}'), now(), now())`).join(",");

  runSql(`
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) values ${authRows};
    update public.users users
    set role_id = roles.id, active = true, updated_at = now()
    from public.roles roles
    where users.id in (${actorList})
      and roles.name = case users.id
        ${Object.entries(actorIds).map(([role, id]) => `when '${id}'::uuid then '${role}'`).join("\n")}
      end;
  `);

  const roleMatrix = runSql(`
    select name || '|' || (permissions ? 'pos:create_sale') || '|' || (permissions ? 'pos:apply_discount')
    from public.roles
    where name in ('technical_owner','business_owner','admin','contadora','vendedor','bodega','soporte','cliente')
    order by name;
  `).split("\n");
  assert.equal(roleMatrix.length, 8);
  for (const row of roleMatrix) {
    const [role, createSale, discount] = row.split("|");
    const expected = ["technical_owner", "business_owner", "admin"].includes(role) ? "true" : "false";
    assert.equal(createSale, expected, `${role} pos:create_sale`);
    assert.equal(discount, expected, `${role} pos:apply_discount`);
  }

  for (const [role, id] of Object.entries(actorIds)) {
    const expected = ["technical_owner", "business_owner", "admin"].includes(role) ? "true|true" : "false|false";
    const output = runSql(withActor(id,
      "select public.pos_permission_allowed('pos:create_sale') || '|' || public.pos_permission_allowed('pos:apply_discount');"));
    assert.equal(output.split("\n").slice(-1)[0], expected, `Database permission gate for ${role}`);
  }
  assert.equal(runSql("select public.pos_permission_allowed('pos:create_sale');"), "f");

  const grants = runSql(`
    select
      has_table_privilege('anon', 'public.pos_idempotency_requests', 'select'),
      has_table_privilege('authenticated', 'public.pos_idempotency_requests', 'select'),
      has_function_privilege('anon', 'public.get_pos_idempotency_status_v1(uuid,text)', 'execute'),
      has_function_privilege('authenticated', 'public.get_pos_idempotency_status_v1(uuid,text)', 'execute'),
      has_function_privilege('authenticated', 'public.claim_pos_idempotency_v1(uuid,text,text)', 'execute'),
      (select relrowsecurity from pg_class where oid = 'public.pos_idempotency_requests'::regclass);
  `);
  assert.equal(grants, "f|f|f|t|f|t");

  runSql(`begin; set local role authenticated; select * from public.pos_idempotency_requests; rollback;`, { expectedFailure: /permission denied/i });
  runSql(`begin; set local role anon; select * from public.pos_idempotency_requests; rollback;`, { expectedFailure: /permission denied/i });
  runSql(`begin; set local role authenticated; select public.claim_pos_idempotency_v1('${requestKey}','${operation}','${hashA}'); rollback;`, { expectedFailure: /permission denied/i });
  runSql(withActor(actorIds.cliente, `set local role authenticated; select * from public.get_pos_idempotency_status_v1('${requestKey}','${operation}');`), { expectedFailure: /No tienes permiso/i });

  runSql(`
    begin;
    insert into public.orders (
      order_number, user_id, customer_id, customer_name, phone, customer_phone,
      delivery_address, payment_method, subtotal, tax, total
    ) values (
      'POS_TEST_WEB_DEFAULT', '${actorIds.cliente}',
      (select id from public.customers where business_name = 'Auto Repuestos Lopez' limit 1),
      'POS TEST', '+504 0000-9999', '+504 0000-9999', 'Test', 'cash', 100, 0, 100
    );
    do $$
    declare saved public.orders%rowtype;
    begin
      select * into saved from public.orders where order_number = 'POS_TEST_WEB_DEFAULT';
      if saved.source <> 'web' or saved.channel <> 'website' or saved.created_by is not null or saved.seller_id is not null then
        raise exception 'Web defaults or nullable actor fields are invalid';
      end if;
      if saved.user_id <> '${actorIds.cliente}'::uuid or saved.customer_id is null then
        raise exception 'Portal buyer and commercial customer semantics changed';
      end if;

      begin
        insert into public.orders (order_number, customer_name, phone, customer_phone, delivery_address, payment_method, subtotal, tax, total, source, channel)
        values ('POS_TEST_INVALID_POS', 'POS TEST', '1', '1', 'Test', 'cash', 1, 0, 1, 'pos', 'store');
        raise exception 'Invalid POS origin was accepted';
      exception when check_violation then null;
      end;

      insert into public.orders (order_number, customer_name, phone, customer_phone, delivery_address, payment_method, subtotal, tax, total, source, channel, created_by)
      values ('POS_TEST_VALID_POS', 'POS TEST', '1', '1', 'Test', 'cash', 1, 0, 1, 'pos', 'store', '${actorIds.admin}');

      begin
        set local role authenticated;
        update public.orders set channel = 'phone' where order_number = 'POS_TEST_WEB_DEFAULT';
        if found then
          raise exception 'Authenticated provenance rewrite was accepted';
        end if;
      exception when insufficient_privilege then null;
      end;
    end $$;
    rollback;
  `);

  runSql(withActor(actorIds.admin, `select public.claim_pos_idempotency_v1('not-a-uuid','${operation}','${hashA}');`), { expectedFailure: /invalid input syntax for type uuid/i });
  runSql(withActor(actorIds.admin, `select public.claim_pos_idempotency_v1('00000000-0000-0000-0000-000000000000','${operation}','${hashA}');`), { expectedFailure: /clave de idempotencia no es valida/i });

  const canonicalHash = runSql(`
    select encode(digest(convert_to(('{"b":2,"a":1}'::jsonb)::text, 'UTF8'), 'sha256'), 'hex') =
           encode(digest(convert_to(('{"a":1,"b":2}'::jsonb)::text, 'UTF8'), 'sha256'), 'hex');
  `);
  assert.equal(canonicalHash, "t");

  const claimSql = withActor(actorIds.admin,
    `select request_status || '|' || acquired || '|' || replayed from public.claim_pos_idempotency_v1('${requestKey}','${operation}','${hashA}');`);
  const concurrent = await Promise.all([runSqlAsync(claimSql), runSqlAsync(claimSql)]);
  const claimLines = concurrent.map((value) => value.split("\n").slice(-1)[0]).sort();
  assert.deepEqual(claimLines, ["processing|false|true", "processing|true|false"]);
  assert.equal(runSql(`select attempt_count from public.pos_idempotency_requests where request_key='${requestKey}';`), "2");

  runSql(`update public.pos_idempotency_requests set lease_expires_at = now() - interval '1 minute' where request_key='${requestKey}';`);
  const expiredReplay = runSql(claimSql).split("\n").slice(-1)[0];
  assert.equal(expiredReplay, "processing|false|true");
  assert.equal(runSql(`select (lease_expires_at < now()) || '|' || status from public.pos_idempotency_requests where request_key='${requestKey}';`), "true|processing");

  runSql(withActor(actorIds.admin, `select public.claim_pos_idempotency_v1('${requestKey}','${operation}','${hashB}');`), { expectedFailure: /datos diferentes/i });
  runSql(withActor(actorIds.business_owner, `select public.claim_pos_idempotency_v1('${requestKey}','${operation}','${hashA}');`), { expectedFailure: /otro actor/i });

  const completed = runSql(withActor(actorIds.admin,
    `select public.complete_pos_idempotency_v1('${requestKey}','${operation}','${hashA}','{"order_id":"POS_TEST_NONE"}'::jsonb);`));
  assert.match(completed, /POS_TEST_NONE/);
  const succeededReplay = runSql(claimSql).split("\n").slice(-1)[0];
  assert.equal(succeededReplay, "succeeded|false|true");
  assert.equal(runSql(`select status || '|' || attempt_count || '|' || (result->>'order_id') from public.pos_idempotency_requests where request_key='${requestKey}';`), "succeeded|4|POS_TEST_NONE");
  runSql(withActor(actorIds.admin, `select public.complete_pos_idempotency_v1('${requestKey}','${operation}','${hashA}','{"order_id":"OTHER"}'::jsonb);`), { expectedFailure: /resultado idempotente existente no coincide/i });

  runSql(withActor(actorIds.admin, `select * from public.claim_pos_idempotency_v1('${failedKey}','${operation}','${hashA}');`));
  runSql(withActor(actorIds.admin, `select public.fail_pos_idempotency_v1('${failedKey}','${operation}','${hashA}',repeat('C',100),repeat('M',400));`));
  assert.equal(runSql(`select status || '|' || length(safe_error->>'code') || '|' || length(safe_error->>'message') from public.pos_idempotency_requests where request_key='${failedKey}';`), "failed|80|300");
  const failedReplay = runSql(withActor(actorIds.admin,
    `select request_status || '|' || replayed || '|' || (stored_error->>'code') from public.claim_pos_idempotency_v1('${failedKey}','${operation}','${hashA}');`));
  assert.match(failedReplay, /failed\|true\|C{80}/);

  const ownRows = runSql(withActor(actorIds.admin,
    `set local role authenticated; select count(*) from public.get_pos_idempotency_status_v1('${requestKey}','${operation}');`)).split("\n").slice(-1)[0];
  assert.equal(ownRows, "1");
  const otherRows = runSql(withActor(actorIds.business_owner,
    `set local role authenticated; select count(*) from public.get_pos_idempotency_status_v1('${requestKey}','${operation}');`)).split("\n").slice(-1)[0];
  assert.equal(otherRows, "0");

  const states = runSql(`select string_agg(status, ',' order by status) from public.pos_idempotency_requests where operation='${operation}';`);
  assert.equal(states, "failed,succeeded");
  console.log("POS local SQL foundation checks passed.", { roleCount: 8, concurrentClaims: claimLines, states });
} finally {
  runSql(cleanupSql);
  const residue = runSql(`
    select jsonb_build_object(
      'auth_users', (select count(*) from auth.users where id in (${actorList})),
      'public_users', (select count(*) from public.users where id in (${actorList})),
      'orders', (select count(*) from public.orders where order_number like 'POS_TEST_%'),
      'idempotency', (select count(*) from public.pos_idempotency_requests where operation='${operation}'),
      'audit_logs', (select count(*) from public.audit_logs where user_id in (${actorList}))
    );
  `);
  console.log("POS local fixture residue:", residue);
}
