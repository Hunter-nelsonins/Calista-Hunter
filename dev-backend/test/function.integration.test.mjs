// Integration test: the real wt-admin logic running against the local fake backend with the REAL
// database rules (migration 005 applied to an in-memory Postgres) and real supabase-js client calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../../node_modules/@supabase/supabase-js/dist/index.mjs';
import { startServer, ANON_KEY } from '../server.mjs';
import { HUNTER_ID, CALISTA_ID } from '../db.mjs';

const PORT = 54399;
let srv;
const client = () => createClient(`http://localhost:${PORT}`, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
async function login(email, password) {
  const c = client(); const { data, error } = await c.auth.signInWithPassword({ email, password });
  assert.ifError(error); return { c, session: data.session };
}
const call = async (c, body) => { const { data, error } = await c.functions.invoke('wt-admin', { body }); if (error) { let msg = error.message; try { msg = (await error.context.json()).error; } catch {} return { error: msg, status: error.context?.status }; } return { data }; };

test.before(async () => { srv = await startServer({ port: PORT, stranger: true, quiet: true, expandedSample: false }); });
test.after(async () => { await srv.close(); });

test('Hunter lists both accounts through the real client; Calista and a stranger are refused', async () => {
  const h = await login('hunter@example.test', 'LocalTest-Hunter-1!');
  const r = await call(h.c, { action: 'list_accounts' });
  assert.equal(r.error, undefined);
  assert.equal(r.data.accounts.length, 2);
  assert.deepEqual(r.data.accounts.map(a => a.key).sort(), ['calista', 'hunter']);
  const c = await login('calista@example.test', 'LocalTest-Calista-1!');
  assert.equal((await call(c.c, { action: 'list_accounts' })).status, 403);
  const s = await login('stranger@example.test', 'LocalTest-Stranger-1!');
  assert.equal((await call(s.c, { action: 'list_accounts' })).status, 403);
  const anon = client(); assert.equal((await call(anon, { action: 'list_accounts' })).status, 401);
});

test('full reset flow: temp password, forced change, database gate, then normal access', async () => {
  const h = await login('hunter@example.test', 'LocalTest-Hunter-1!');
  const reset = await call(h.c, { action: 'reset_password', target_id: CALISTA_ID, current_password: 'LocalTest-Hunter-1!' });
  assert.ok(reset.data.temporary_password);
  const temp = reset.data.temporary_password;

  // old password no longer works; temp does
  assert.ok((await client().auth.signInWithPassword({ email: 'calista@example.test', password: 'LocalTest-Calista-1!' })).error);
  const cal = await login('calista@example.test', temp);

  // database withholds the new features while the flag is set
  const day = 'bbbbbbbb-0001-4000-8000-000000000002';
  const blocked = await cal.c.from('devotional_answers').insert({ day_id: day, user_id: CALISTA_ID, answer_text: 'x', status: 'draft' });
  assert.ok(blocked.error, 'write refused while a password change is pending');
  const flag = await cal.c.from('account_details').select('must_change_password').eq('user_id', CALISTA_ID).maybeSingle();
  assert.equal(flag.data.must_change_password, true, 'she can still read her own flag so the app can route her');

  // she completes the change through the function
  assert.equal((await call(cal.c, { action: 'complete_password_change', current_password: temp, new_password: 'short' })).status, 400);
  const done = await call(cal.c, { action: 'complete_password_change', current_password: temp, new_password: 'A-Brand-New-Passw0rd' });
  assert.equal(done.error, undefined);
  const cal2 = await login('calista@example.test', 'A-Brand-New-Passw0rd');
  const ok = await cal2.c.from('devotional_answers').insert({ day_id: day, user_id: CALISTA_ID, answer_text: 'x', status: 'draft' });
  assert.ifError(ok.error);

  // audit log: written, readable by Hunter only, contains no secrets
  const audit = await h.c.from('admin_audit_log').select('*');
  assert.ok(audit.data.length >= 2);
  assert.ok(!JSON.stringify(audit.data).includes(temp));
  assert.ok(!JSON.stringify(audit.data).includes('A-Brand-New-Passw0rd'));
  assert.equal((await cal2.c.from('admin_audit_log').select('*')).data.length, 0);
});

test('username and display name edits, and uniqueness, through the real database', async () => {
  const h = await login('hunter@example.test', 'LocalTest-Hunter-1!');
  assert.equal((await call(h.c, { action: 'update_account', target_id: CALISTA_ID, fields: { username: 'calista', display_name: 'Calista' } })).error, undefined);
  assert.equal((await call(h.c, { action: 'update_account', target_id: HUNTER_ID, fields: { username: 'CALISTA' } })).status, 400);
  assert.equal((await call(h.c, { action: 'update_account', target_id: HUNTER_ID, fields: { username: 'calista' } })).status, 409);
  const list = (await call(h.c, { action: 'list_accounts' })).data.accounts;
  assert.equal(list.find(a => a.key === 'calista').username, 'calista');
});

test('the browser cannot write account tables or flags directly', async () => {
  const c = await login('calista@example.test', 'A-Brand-New-Passw0rd').catch(() => login('calista@example.test', 'LocalTest-Calista-1!'));
  const a = await c.c.from('account_details').update({ must_change_password: false, username: 'hacker' }).eq('user_id', CALISTA_ID).select();
  assert.ok(a.error || (a.data || []).length === 0);
  const m = await c.c.from('app_members').update({ role: 'admin' }).eq('user_id', CALISTA_ID).select();
  assert.ok(m.error || (m.data || []).length === 0);
});
