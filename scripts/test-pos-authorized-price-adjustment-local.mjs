import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
// A fixed local Docker target; no URL, credentials, remote fallback or migration.
const container = 'supabase_db_car-zone-accesorios';
const identity = execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', 'select current_database();'], { encoding: 'utf8' }).trim();
assert.equal(identity, 'postgres');
execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
  input: readFileSync(new URL('./test-pos-authorized-price-adjustment-local.sql', import.meta.url)), stdio: ['pipe', 'inherit', 'inherit'],
});
