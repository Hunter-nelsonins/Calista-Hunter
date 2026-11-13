// Offline security tests for the wt-admin function logic (no network, no Supabase). Fake in-memory dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, generateTemporaryPassword, HUNTER_ID, CALISTA_ID } from '../../supabase/functions/wt-admin/core.js';

const STRANGER = '99999999-0000-4000-8000-000000000009';
const THIRD = '12345678-0000-4000-8000-000000000001';

function world({ hunterIsAdminMember = true } = {}) {
  const w = {
    pw: { 'hunter@example.test': 'Hunter-Real-Password-1', 'calista@example.test': 'Calista-Temp-Password-1' },
    auth: { [HUNTER_ID]: { id: HUNTER_ID, email: 'hunter@example.test' }, [CALISTA_ID]: { id: CALISTA_ID, email: 'calista@example.test' } },
    profiles: { [HUNTER_ID]: { display_name: 'Hunter' }, [CALISTA_ID]: { display_name: 'Calista' } },
    details: { [HUNTER_ID]: { username: null, must_change_password: false }, [CALISTA_ID]: { username: null, must_change_password: false } },
    audit: [], calls: [], failAuditAt: null,
    tokens: { 'tok-hunter': { id: HUNTER_ID, email: 'hunter@example.test' }, 'tok-calista': { id: CALISTA_ID, email: 'calista@example.test' }, 'tok-stranger': { id: STRANGER, email: 's@example.test' } },
  };
  w.deps = {
    verifyToken: async j => w.tokens[j] || null,
    verifyPassword: async (email, p) => w.pw[email] === p,
    isAdminMember: async id => id === HUNTER_ID && hunterIsAdminMember,
    getAuthUser: async id => w.auth[id],
    getProfile: async id => w.profiles[id],
    setDisplayName: async (id, n) => { w.calls.push('setDisplayName'); w.profiles[id].display_name = n; },
    getAccountDetails: async id => w.details[id],
    setAccountDetails: async (id, patch) => { w.calls.push('setAccountDetails'); Object.assign(w.details[id], patch); },
    usernameTaken: async (u, except) => Object.entries(w.details).some(([id, d]) => id !== except && d.username === u),
    changeEmail: async (id, e) => { w.calls.push('changeEmail'); w.auth[id].email = e; },
    updateAuthPassword: async (id, p) => { w.calls.push('updateAuthPassword'); w.pw[w.auth[id].email] = p; w.lastSetPassword = p; },
    revokeSessions: async () => { w.calls.push('revokeSessions'); },
    writeAudit: async e => { w.calls.push('audit'); w.audit.push({ ...e, at: Date.now() }); },
    recentReauthFailures: async (actor, since) => w.audit.filter(a => a.actor_id === actor && a.action === 'reauth_failed' && a.at >= since).length,
  };
  w.call = async (token, body, { origin = 'http://localhost:4321', method = 'POST', raw } = {}) => {
    const h = { 'content-type': 'application/json' }; if (token) h.authorization = `Bearer ${token}`; if (origin) h.origin = origin;
    const r = await createHandler(w.deps)(new Request('http://x/fn', { method, headers: h, body: method === 'GET' ? undefined : (raw ?? JSON.stringify(body)) }));
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  };
  return w;
}

test('requires a signed-in caller; strangers and unknown accounts are refused', async () => {
  const w = world();
  assert.equal((await w.call(null, { action: 'list_accounts' })).status, 401);
  assert.equal((await w.call('garbage', { action: 'list_accounts' })).status, 401);
  assert.equal((await w.call('tok-stranger', { action: 'list_accounts' })).status, 403);
  assert.equal((await w.call('tok-stranger', { action: 'complete_password_change', current_password: 'x', new_password: 'Abcdefghijkl1' })).status, 403);
  assert.deepEqual(w.calls, [], 'nothing was written');
});

test('Calista cannot use any administrator action', async () => {
  const w = world();
  assert.equal((await w.call('tok-calista', { action: 'list_accounts' })).status, 403);
  assert.equal((await w.call('tok-calista', { action: 'reset_password', target_id: HUNTER_ID, current_password: w.pw['calista@example.test'] })).status, 403);
  assert.equal((await w.call('tok-calista', { action: 'update_account', target_id: HUNTER_ID, fields: { display_name: 'Hacked' } })).status, 403);
  assert.equal((await w.call('tok-calista', { action: 'update_account', target_id: CALISTA_ID, fields: { username: 'calista' } })).status, 403);
  assert.equal((await w.call('tok-calista', { action: 'update_account', target_id: CALISTA_ID, fields: { email: 'x@example.test' }, confirm_email: 'x@example.test', current_password: 'p' })).status, 403);
  assert.deepEqual(w.calls, []);
  assert.equal(w.profiles[HUNTER_ID].display_name, 'Hunter');
});

test('client-supplied admin claims and caller IDs are ignored', async () => {
  const w = world();
  for (const extra of [{ is_admin: true }, { role: 'admin' }, { caller_id: HUNTER_ID }, { user_id: HUNTER_ID }, { admin: true }]) {
    assert.equal((await w.call('tok-calista', { action: 'list_accounts', ...extra })).status, 403);
    assert.equal((await w.call('tok-calista', { action: 'reset_password', target_id: HUNTER_ID, current_password: 'x', ...extra })).status, 403);
  }
});

test('administrator needs BOTH the fixed Hunter ID and the allowlist role', async () => {
  const w = world({ hunterIsAdminMember: false });
  assert.equal((await w.call('tok-hunter', { action: 'list_accounts' })).status, 403);
});

test('Hunter can list both accounts; the response never contains passwords or hashes', async () => {
  const w = world();
  const r = await w.call('tok-hunter', { action: 'list_accounts' });
  assert.equal(r.status, 200);
  assert.equal(r.body.accounts.length, 2);
  const text = JSON.stringify(r.body);
  assert.ok(!/password_hash|encrypted_password|Real-Password|Temp-Password/i.test(text));
});

test('only the two approved accounts can be targeted', async () => {
  const w = world();
  for (const id of [THIRD, STRANGER, '', null, 42, undefined, "' or 1=1 --"]) {
    assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: id, fields: { display_name: 'X' } })).status, 400);
    assert.equal((await w.call('tok-hunter', { action: 'reset_password', target_id: id, current_password: w.pw['hunter@example.test'] })).status, 400);
  }
  assert.deepEqual(w.calls, []);
});

test('Hunter edits display name and username; validation and uniqueness enforced', async () => {
  const w = world();
  assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: CALISTA_ID, fields: { display_name: 'Calista N.' } })).status, 200);
  assert.equal(w.profiles[CALISTA_ID].display_name, 'Calista N.');
  assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: CALISTA_ID, fields: { username: 'calista' } })).status, 200);
  assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: HUNTER_ID, fields: { username: 'calista' } })).status, 409);
  for (const bad of ['AB', 'Has Space', 'a'.repeat(31), 'UPPER', 'bad!char']) assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: HUNTER_ID, fields: { username: bad } })).status, 400, bad);
  for (const bad of ['', '   ', 'x'.repeat(51), '<script>']) assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: HUNTER_ID, fields: { display_name: bad } })).status, 400, bad);
  assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: HUNTER_ID, fields: { is_admin: true } })).status, 400);
  assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: HUNTER_ID, fields: {} })).status, 400);
});

test('Calista can change only her own display name', async () => {
  const w = world();
  assert.equal((await w.call('tok-calista', { action: 'update_account', target_id: CALISTA_ID, fields: { display_name: 'Calista' } })).status, 200);
  assert.equal((await w.call('tok-calista', { action: 'update_account', target_id: HUNTER_ID, fields: { display_name: 'Nope' } })).status, 403);
});

test('email change by the administrator requires re-typing the address and re-entering his own password', async () => {
  const w = world();
  const f = { email: 'new@example.test' };
  assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: CALISTA_ID, fields: f })).status, 400, 'no confirm');
  assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: CALISTA_ID, fields: f, confirm_email: 'new@example.test' })).status, 400, 'no password');
  assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: CALISTA_ID, fields: f, confirm_email: 'new@example.test', current_password: 'wrong' })).status, 403);
  assert.ok(!w.calls.includes('changeEmail'));
  assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: CALISTA_ID, fields: { email: 'not-an-email' }, confirm_email: 'not-an-email', current_password: w.pw['hunter@example.test'] })).status, 400);
  assert.equal((await w.call('tok-hunter', { action: 'update_account', target_id: CALISTA_ID, fields: f, confirm_email: 'new@example.test', current_password: w.pw['hunter@example.test'] })).status, 200);
  assert.ok(w.calls.includes('changeEmail'));
});

test('password reset: re-authentication, rate limit, generated temp password, forced change, no secrets in audit', async () => {
  const w = world();
  const good = w.pw['hunter@example.test'];
  assert.equal((await w.call('tok-hunter', { action: 'reset_password', target_id: CALISTA_ID })).status, 400, 'missing password');
  assert.equal((await w.call('tok-hunter', { action: 'reset_password', target_id: CALISTA_ID, current_password: 'wrong' })).status, 403);
  assert.ok(!w.calls.includes('updateAuthPassword'));
  const ok = await w.call('tok-hunter', { action: 'reset_password', target_id: CALISTA_ID, current_password: good });
  assert.equal(ok.status, 200);
  const temp = ok.body.temporary_password;
  assert.match(temp, /^[A-Za-z0-9]{20}$/);
  assert.equal(w.lastSetPassword, temp);
  assert.equal(w.details[CALISTA_ID].must_change_password, true);
  assert.ok(w.calls.includes('revokeSessions'));
  assert.equal(JSON.stringify(w.audit).includes(temp), false, 'temporary password is not in the audit log');
  assert.ok(!/password"?\s*:/.test(JSON.stringify(w.audit.map(a => a.details)).replace(/must_change_password/g, '')), 'no password fields in audit details');
  assert.ok(w.audit.some(a => a.action === 'reset_password' && a.target_user_id === CALISTA_ID));
  // Hunter cannot reset himself through this path
  assert.equal((await w.call('tok-hunter', { action: 'reset_password', target_id: HUNTER_ID, current_password: good })).status, 400);
});

test('wrong passwords are rate-limited (5 failures in 15 minutes, even if the next try is right)', async () => {
  const w = world();
  for (let i = 0; i < 5; i++) assert.equal((await w.call('tok-hunter', { action: 'reset_password', target_id: CALISTA_ID, current_password: 'wrong' + i })).status, 403);
  assert.equal((await w.call('tok-hunter', { action: 'reset_password', target_id: CALISTA_ID, current_password: w.pw['hunter@example.test'] })).status, 429);
  assert.ok(!w.calls.includes('updateAuthPassword'));
});

test('administrator-chosen temporary password must be strong; dry run writes nothing', async () => {
  const w = world(); const good = w.pw['hunter@example.test'];
  assert.equal((await w.call('tok-hunter', { action: 'reset_password', target_id: CALISTA_ID, current_password: good, new_password: 'short' })).status, 400);
  assert.equal((await w.call('tok-hunter', { action: 'reset_password', target_id: CALISTA_ID, current_password: good, new_password: 'aaaaaaaaaaaaaaaa' })).status, 400);
  const dry = await w.call('tok-hunter', { action: 'reset_password', target_id: CALISTA_ID, current_password: good, dry_run: true });
  assert.equal(dry.status, 200); assert.equal(dry.body.dry_run, true); assert.equal(dry.body.temporary_password, undefined);
  assert.ok(!w.calls.includes('updateAuthPassword') && !w.calls.includes('setAccountDetails'));
  const chosen = await w.call('tok-hunter', { action: 'reset_password', target_id: CALISTA_ID, current_password: good, new_password: 'A-Good-Temp-Pass-77' });
  assert.equal(chosen.status, 200); assert.equal(chosen.body.temporary_password, undefined, 'a password the admin typed is never echoed back');
});

test('completing a forced password change: needs the temporary password, a strong different new one; clears the flag', async () => {
  const w = world(); w.details[CALISTA_ID].must_change_password = true;
  const cur = w.pw['calista@example.test'];
  assert.equal((await w.call('tok-calista', { action: 'complete_password_change', current_password: 'wrong', new_password: 'Brand-New-Passw0rd' })).status, 403);
  assert.equal((await w.call('tok-calista', { action: 'complete_password_change', current_password: cur, new_password: 'short' })).status, 400);
  assert.equal((await w.call('tok-calista', { action: 'complete_password_change', current_password: cur, new_password: cur })).status, 400);
  assert.equal(w.details[CALISTA_ID].must_change_password, true);
  assert.equal((await w.call('tok-calista', { action: 'complete_password_change', current_password: cur, new_password: 'Brand-New-Passw0rd' })).status, 200);
  assert.equal(w.details[CALISTA_ID].must_change_password, false);
  assert.equal(w.pw['calista@example.test'], 'Brand-New-Passw0rd');
  // it always acts on the caller, never on a target supplied in the body
  assert.equal(w.pw['hunter@example.test'], 'Hunter-Real-Password-1');
  const r = await w.call('tok-calista', { action: 'complete_password_change', target_id: HUNTER_ID, current_password: 'Brand-New-Passw0rd', new_password: 'Another-Fine-Passw0rd' });
  assert.equal(r.status, 200); assert.equal(w.pw['hunter@example.test'], 'Hunter-Real-Password-1');
});

test('transport rules: origin allowlist, methods, preflight, body size, bad JSON, unknown action, generic 500', async () => {
  const w = world();
  assert.equal((await w.call('tok-hunter', { action: 'list_accounts' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await w.call('tok-hunter', { action: 'list_accounts' }, { method: 'GET' })).status, 405);
  const pre = await w.call(null, null, { method: 'OPTIONS' }); assert.equal(pre.status, 204);
  assert.equal((await w.call('tok-hunter', null, { raw: 'x'.repeat(20000) })).status, 413);
  assert.equal((await w.call('tok-hunter', null, { raw: '{not json' })).status, 400);
  assert.equal((await w.call('tok-hunter', null, { raw: '[1,2]' })).status, 400);
  assert.equal((await w.call('tok-hunter', { action: 'delete_user', target_id: CALISTA_ID })).status, 400);
  assert.equal((await w.call('tok-hunter', { action: 'create_user', email: 'new@example.test' })).status, 400);
  w.deps.getAuthUser = async () => { throw new Error('SECRET internal detail: key=abc123'); };
  const r = await w.call('tok-hunter', { action: 'list_accounts' });
  assert.equal(r.status, 500); assert.ok(!JSON.stringify(r.body).includes('SECRET'));
});

test('temporary password generator: 20 chars, no look-alikes, no repeats across 2000 draws', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) { const p = generateTemporaryPassword(); assert.match(p, /^[A-HJ-NP-Za-km-z2-9]{20}$/); seen.add(p); }
  assert.equal(seen.size, 2000);
});
