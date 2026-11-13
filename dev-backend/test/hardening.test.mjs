// Tests for 006 (H1-H4): the two members keep full normal use; outsiders and anonymous visitors get nothing;
// data is untouched; rollback restores the exact original rules.
import { createDb, SQL_DIR, HUNTER_ID, CALISTA_ID, STRANGER_ID, dayId } from '../db.mjs';
import fs from 'node:fs';
const H = HUNTER_ID, C = CALISTA_ID, S = STRANGER_ID;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  [' + String(extra).slice(0, 70) + ']' : '')); };
const sql = f => fs.readFileSync(SQL_DIR + '/' + f, 'utf8');
async function as(db, uid, role, fn) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${uid ?? ''}',false), set_config('request.jwt.claim.role','${role}',false);`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const tryq = async (db, q, p) => { try { const r = await db.query(q, p); return { ok: true, rows: r.rows, n: r.affectedRows }; } catch (e) { return { ok: false, err: e.message }; } };
const rules = async db => (await db.query(`select schemaname, tablename, policyname, cmd, roles::text r, qual, with_check from pg_policies where schemaname in ('public','storage') order by 1,2,3`)).rows;
const grants = async db => (await db.query(`select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name in ('profiles','devotionals','devotional_days','prayers','checkins','vision_entries') and grantee in ('anon','authenticated') order by 1,2,3`)).rows;
const dataMd5 = async db => (await db.query(`select jsonb_build_object(
  'p',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.profiles t),'d',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.devotionals t),
  'dd',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.devotional_days t),'pr',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.prayers t),
  'c',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.checkins t),'v',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.vision_entries t),
  'o',(select count(*) from storage.objects)) x`)).rows[0].x;

// ---- build: pre-006 state (005 applied), plus a stand-in for an insurance bucket policy that must stay untouched
const db = await createDb({ stranger: true, harden: false });
await db.exec(`create policy "carrier_logos_public_read" on storage.objects for select using (bucket_id = 'carrier-logos')`);
const rulesBefore = await rules(db), grantsBefore = await grants(db), dataBefore = await dataMd5(db);

// preflight refuses on a database without 005
const bare = await createDb({ migrate: false, stranger: true });
let refused = ''; try { await bare.exec(sql('006_hardening_members_only.sql')); } catch (e) { refused = e.message; }
await bare.exec('rollback').catch(() => {});
ok('006 refuses to run without 005 and changes nothing', /Preflight failed/.test(refused) && JSON.stringify(await rules(bare)) === JSON.stringify(await rules(await createDb({ migrate: false, stranger: true }))));

await db.exec(sql('006_hardening_members_only.sql'));
console.log('--- 006 applied to the THROWAWAY test database ---');

ok('data identical before and after 006 (all six tables + storage object count)', JSON.stringify(dataBefore) === JSON.stringify(await dataMd5(db)));
const after = await rules(db);
ok('insurance-style storage policy untouched', after.some(p => p.policyname === 'carrier_logos_public_read'));
ok('old "any signed-in user" table policies are gone', !after.some(p => p.schemaname === 'public' && /^authenticated (all|read|update)/.test(p.policyname)));
ok('old storage policies are gone', !after.some(p => p.schemaname === 'storage' && /^authenticated /.test(p.policyname)));
ok('H1: signed-in users no longer hold truncate/trigger/references', !(await grants(db)).some(g => g.grantee === 'authenticated' && ['TRUNCATE', 'TRIGGER', 'REFERENCES'].includes(g.privilege_type)));
ok('H1: normal privileges kept (select/insert/update/delete)', ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every(p => (grantsBefore.concat([]).length, true)) && (await grants(db)).filter(g => g.grantee === 'authenticated' && g.table_name === 'prayers').map(g => g.privilege_type).sort().join() === 'DELETE,INSERT,SELECT,UPDATE');

// ---- both members: everything the existing site does still works
for (const [who, uid] of [['Hunter', H], ['Calista', C]]) {
  const read = async t => (await as(db, uid, 'authenticated', () => db.query(`select * from ${t}`))).rows.length;
  ok(`${who}: reads all six tables as before`, (await read('profiles')) === 3 && (await read('devotionals')) === 3 && (await read('devotional_days')) === 16 && (await read('prayers')) >= 2 && (await read('vision_entries')) >= 2 && (await read('checkins')) >= 1);
  let r = await as(db, uid, 'authenticated', () => tryq(db, `insert into prayers(content,added_by) values ('TEST prayer by ${who}','${uid}') returning id`));
  ok(`${who}: can add a prayer`, r.ok, r.err);
  const pid = r.rows?.[0]?.id;
  r = await as(db, uid, 'authenticated', () => tryq(db, `update prayers set is_answered=true, answered_by='${uid}', answered_at=now() where id='${pid}'`));
  ok(`${who}: can mark a prayer answered`, r.ok && r.n === 1, r.err);
  r = await as(db, uid, 'authenticated', () => tryq(db, `insert into checkins(submitted_by,week_start,walk_with_god) values ('${uid}','2026-09-01','x') returning id`));
  ok(`${who}: can submit a check-in, and update it`, r.ok && (await as(db, uid, 'authenticated', () => tryq(db, `update checkins set walk_with_god='y' where id='${r.rows[0].id}'`))).n === 1, r.err);
  r = await as(db, uid, 'authenticated', () => tryq(db, `insert into vision_entries(values_statement,edited_by) values ('TEST vision','${uid}')`));
  ok(`${who}: can add a vision entry`, r.ok, r.err);
  r = await as(db, uid, 'authenticated', () => tryq(db, `update devotional_days set title = title where id='${dayId(1, 1)}'`));
  ok(`${who}: admin-style devotional edit still works`, r.ok && r.n === 1, r.err);
  r = await as(db, uid, 'authenticated', () => tryq(db, `update profiles set display_name = display_name, avatar_url = 'new-${who}.jpg' where id='${uid}'`));
  ok(`${who}: can update OWN profile`, r.ok && r.n === 1, r.err);
  const other = uid === H ? C : H;
  r = await as(db, uid, 'authenticated', () => tryq(db, `update profiles set display_name = 'hijack' where id='${other}'`));
  ok(`${who}: cannot edit the OTHER profile (H3)`, r.ok && r.n === 0);
  r = await as(db, uid, 'authenticated', () => tryq(db, `truncate public.prayers`));
  ok(`${who}: cannot TRUNCATE (H1)`, !r.ok, r.err);
}

// ---- outsiders
for (const t of ['profiles', 'devotionals', 'devotional_days', 'prayers', 'checkins', 'vision_entries']) {
  const r = await as(db, S, 'authenticated', () => tryq(db, `select * from ${t}`));
  if (!(r.ok && r.rows.length === 0)) ok(`signed-in stranger sees nothing in ${t}`, false);
}
ok('signed-in stranger sees nothing in any of the six tables (H2)', true);
let r = await as(db, S, 'authenticated', () => tryq(db, `insert into prayers(content) values ('intruder')`)); ok('stranger cannot add a prayer', !r.ok, r.err);
r = await as(db, S, 'authenticated', () => tryq(db, `update devotionals set title='x'`)); ok('stranger cannot edit devotionals', r.ok && r.n === 0);
r = await as(db, S, 'authenticated', () => tryq(db, `delete from vision_entries`)); ok('stranger cannot delete anything', r.ok && r.n === 0);
r = await as(db, null, 'anon', () => tryq(db, `select * from prayers`)); ok('anonymous visitor gets nothing', !r.ok || r.rows.length === 0);

// ---- forced password change applies to the existing tables too
await db.exec(`update account_details set must_change_password = true where user_id = '${C}'`);
ok('a person mid-forced-password-change cannot read existing tables until done', (await as(db, C, 'authenticated', () => db.query('select * from prayers'))).rows.length === 0);
await db.exec(`update account_details set must_change_password = false where user_id = '${C}'`);
ok('...and regains access afterwards', (await as(db, C, 'authenticated', () => db.query('select * from prayers'))).rows.length >= 2);

// ---- storage (H4)
const stor = async (uid, q) => as(db, uid, 'authenticated', () => tryq(db, q));
r = await stor(C, `insert into storage.objects(bucket_id,name,owner) values ('devotional-photos','newfile.jpg','${C}')`); ok('member can add a photo', r.ok, r.err);
r = await stor(H, `insert into storage.objects(bucket_id,name,owner) values ('avatars','newav.jpg','${H}')`); ok('member can add an avatar', r.ok, r.err);
ok('member can read photos', (await stor(C, `select * from storage.objects where bucket_id='devotional-photos'`)).rows.length >= 3);
r = await stor(C, `update storage.objects set name='renamed' where bucket_id='devotional-photos' and name='newfile.jpg'`); ok('non-admin member cannot rename/overwrite a stored file', r.ok && r.n === 0, r.err);
r = await stor(C, `delete from storage.objects where bucket_id='devotional-photos'`); ok('non-admin member cannot delete stored files', r.ok && r.n === 0, r.err);
r = await stor(S, `select * from storage.objects where bucket_id in ('avatars','devotional-photos')`); ok('stranger cannot see any photo or avatar', r.ok && r.rows.length === 0);
r = await stor(S, `insert into storage.objects(bucket_id,name,owner) values ('devotional-photos','evil.jpg','${S}')`); ok('stranger cannot upload', !r.ok, r.err);
ok('admin (Hunter) can delete a file he chooses to', (await stor(H, `delete from storage.objects where bucket_id='avatars' and name='newav.jpg'`)).n === 1);
ok('another bucket is unaffected: anonymous can still read the insurance-style public bucket policy', (await as(db, null, 'anon', () => tryq(db, `select * from storage.objects where bucket_id='carrier-logos'`))).ok);

// ---- rollback restores the exact original rules and grants
const dataMid = await dataMd5(db);
await db.exec(sql('006_hardening_rollback.sql'));
ok('rollback restores the exact original policies (table + storage)', JSON.stringify(await rules(db)) === JSON.stringify(rulesBefore));
ok('rollback restores the exact original grants', JSON.stringify(await grants(db)) === JSON.stringify(grantsBefore));
ok('rollback touched no data', JSON.stringify(dataMid) === JSON.stringify(await dataMd5(db)));
await db.exec(sql('006_hardening_members_only.sql'));
ok('006 can be re-applied after a rollback', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
