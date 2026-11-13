import { createDb, SQL_DIR, HUNTER_ID, CALISTA_ID, STRANGER_ID, dayId, ORPHAN_DAY_ID } from '../db.mjs';
import fs from 'node:fs';
const MIG = SQL_DIR + '/';
const H = HUNTER_ID, C = CALISTA_ID, S = STRANGER_ID;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  [' + extra + ']' : '')); };

const build = () => createDb({ migrate: false, stranger: true });
const baselineSql = `select jsonb_build_object(
  'profiles',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.profiles t),
  'devotionals',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.devotionals t),
  'days',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.devotional_days t),
  'prayers',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.prayers t),
  'checkins',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.checkins t),
  'vision',(select md5(jsonb_agg(to_jsonb(t) order by t.id)::text) from public.vision_entries t),
  'policies',(select count(*) from pg_policies where schemaname='public' and tablename in ('profiles','devotionals','devotional_days','prayers','checkins','vision_entries')),
  'storage_policies',(select count(*) from pg_policies where schemaname='storage'),
  'users',(select count(*) from auth.users), 'dayrows',(select count(*) from public.devotional_days)) as b`;
const base = async db => (await db.query(baselineSql)).rows[0].b;

async function as(db, uid, role, fn) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${uid ?? ''}',false), set_config('request.jwt.claim.role','${role}',false);`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const tryq = async (db, sql, params) => { try { const r = await db.query(sql, params); return { ok: true, rows: r.rows, n: r.affectedRows }; } catch (e) { return { ok: false, err: e.message }; } };

// ---------------- main run ----------------
const db = await build();
const before = await base(db);
const mig = fs.readFileSync(MIG + '005_additive_walk_together.sql', 'utf8');
await db.exec(mig);
console.log('--- migration applied to the THROWAWAY test database ---');

// preservation
const after = await base(db);
// devotional_days md5 changes only because JSON now has 6 extra null keys: compare with the new keys removed
const keys = "array['supporting_scripture_ref','understanding_text','expanded_reflection','closing_prayer','photo_caption','shared_memory']";
const daysOrig = (await db.query(`select md5(jsonb_agg((to_jsonb(t) - ${keys}) order by t.id)::text) m from public.devotional_days t`)).rows[0].m;
for (const k of ['profiles', 'devotionals', 'prayers', 'checkins', 'vision', 'policies', 'storage_policies', 'users', 'dayrows']) ok(`preserved: ${k}`, JSON.stringify(before[k]) === JSON.stringify(after[k]));
ok('preserved: devotional_days original columns identical (new columns excluded)', daysOrig === before.days);
ok('orphan day row still present and unchanged', (await db.query(`select count(*)::int n from devotional_days where devotional_id is null and title='Fake orphan day' and simple_explanation='orphan reflection'`)).rows[0].n === 1);
ok('new columns are all NULL on every existing row', (await db.query(`select count(*)::int n from devotional_days where supporting_scripture_ref is not null or understanding_text is not null or expanded_reflection is not null or closing_prayer is not null or photo_caption is not null or shared_memory is not null`)).rows[0].n === 0);
ok('allowlist has exactly Hunter=admin, Calista=member', JSON.stringify((await db.query(`select user_id, role from app_members order by role`)).rows.map(r => r.user_id.slice(0, 4) + r.role)) === JSON.stringify(['e6dbadmin', '31d3member']));

const DAY = dayId(1, 1), DAY2 = dayId(1, 2);
const sel = () => db.query(`select user_id, status, answer_text from devotional_answers where day_id='${DAY}'`).then(r => r.rows);

// --- privacy rule ---
let r = await as(db, H, 'authenticated', () => tryq(db, `insert into devotional_answers(day_id,user_id,answer_text,status) values ('${DAY}','${H}','hunter draft','draft')`));
ok('Hunter can save a private draft', r.ok, r.err);
ok('Hunter sees his own draft', (await as(db, H, 'authenticated', sel)).length === 1);
ok('Calista cannot see Hunter\'s draft', (await as(db, C, 'authenticated', sel)).length === 0);

r = await as(db, H, 'authenticated', () => tryq(db, `update devotional_answers set status='submitted', answer_text='hunter final' where day_id='${DAY}' and user_id='${H}'`));
ok('Hunter can submit', r.ok && r.n === 1, r.err);
ok('Calista STILL cannot see Hunter\'s submitted answer (she has not submitted)', (await as(db, C, 'authenticated', sel)).length === 0);
ok('Calista cannot read it by id or by filter either', (await as(db, C, 'authenticated', () => tryq(db, `select * from devotional_answers where user_id='${H}'`))).rows.length === 0);
ok('Hunter sees only his own while waiting', (await as(db, H, 'authenticated', sel)).length === 1);

r = await as(db, C, 'authenticated', () => tryq(db, `insert into devotional_answers(day_id,user_id,answer_text,status) values ('${DAY}','${C}','calista draft','draft')`));
ok('Calista saves a draft', r.ok, r.err);
ok('Hunter cannot see Calista\'s draft', (await as(db, H, 'authenticated', sel)).filter(x => x.user_id === C).length === 0);
ok('Calista (draft only) still cannot see Hunter\'s submitted answer', (await as(db, C, 'authenticated', sel)).filter(x => x.user_id === H).length === 0);

r = await as(db, C, 'authenticated', () => tryq(db, `update devotional_answers set status='submitted', answer_text='calista final' where day_id='${DAY}' and user_id='${C}'`));
ok('Calista submits', r.ok && r.n === 1, r.err);
ok('REVEAL: Hunter now sees both answers', (await as(db, H, 'authenticated', sel)).length === 2);
ok('REVEAL: Calista now sees both answers', (await as(db, C, 'authenticated', sel)).length === 2);
ok('other day unaffected (no cross-day leakage)', (await as(db, H, 'authenticated', () => db.query(`select * from devotional_answers where day_id='${DAY2}'`))).rows.length === 0);

// --- tamper attempts ---
r = await as(db, H, 'authenticated', () => tryq(db, `insert into devotional_answers(day_id,user_id,answer_text,status) values ('${DAY2}','${C}','forged as calista','draft')`));
ok('cannot write an answer as the other person', !r.ok, r.err?.slice(0, 60));
r = await as(db, H, 'authenticated', () => tryq(db, `update devotional_answers set answer_text='tampered' where user_id='${C}'`));
ok('cannot edit the other person\'s answer', r.ok && r.n === 0);
r = await as(db, H, 'authenticated', () => tryq(db, `delete from devotional_answers where day_id='${DAY}'`));
ok('cannot delete answers (no privilege)', !r.ok, r.err?.slice(0, 50));
r = await as(db, H, 'authenticated', () => tryq(db, `update devotional_answers set status='draft' where user_id='${H}'`));
ok('cannot un-submit a revealed answer', !r.ok, r.err?.slice(0, 60));
r = await as(db, H, 'authenticated', () => tryq(db, `update devotional_answers set user_id='${C}' where user_id='${H}'`));
ok('cannot reassign an answer to another user', !r.ok || r.n === 0);
r = await as(db, H, 'authenticated', () => tryq(db, `insert into devotional_answers(day_id,user_id,answer_text,status) values ('${DAY2}','${H}','   ','submitted')`));
ok('cannot submit an empty answer', !r.ok, r.err?.slice(0, 60));
r = await as(db, H, 'authenticated', () => tryq(db, `insert into devotional_answers(day_id,user_id,answer_text,status,submitted_at,created_at) values ('${DAY2}','${H}','forged dates','submitted','2000-01-01','2000-01-01') returning submitted_at, created_at`));
ok('server sets the submission/creation time (client cannot forge dates)', r.ok && new Date(r.rows[0].submitted_at).getFullYear() > 2020 && new Date(r.rows[0].created_at).getFullYear() > 2020);
await as(db, H, 'authenticated', () => db.query(`select 1`));
// edit after reveal keeps history
r = await as(db, H, 'authenticated', () => tryq(db, `update devotional_answers set answer_text='hunter edited' where day_id='${DAY}' and user_id='${H}' returning edited_at`));
ok('edit after reveal allowed, stamped as edited', r.ok && r.rows[0].edited_at !== null, r.err);
ok('previous text preserved in revisions', (await as(db, H, 'authenticated', () => db.query(`select answer_text from devotional_answer_revisions`))).rows.map(x => x.answer_text).join() === 'hunter final');
ok('Calista cannot read Hunter\'s revisions', (await as(db, C, 'authenticated', () => db.query(`select * from devotional_answer_revisions`))).rows.length === 0);
ok('revealed answers stay revealed after an edit', (await as(db, C, 'authenticated', sel)).length === 2);
r = await as(db, H, 'authenticated', () => tryq(db, `insert into devotional_answer_revisions(answer_id,user_id,answer_text) select id,user_id,'x' from devotional_answers limit 1`));
ok('browsers cannot write revisions directly', !r.ok);

// --- outsiders ---
r = await as(db, S, 'authenticated', () => tryq(db, `select * from devotional_answers`));
ok('non-member signed-in user sees no answers', r.ok && r.rows.length === 0);
r = await as(db, S, 'authenticated', () => tryq(db, `insert into devotional_answers(day_id,user_id,answer_text,status) values ('${DAY}','${S}','intruder','draft')`));
ok('non-member cannot write answers', !r.ok);
r = await as(db, null, 'anon', () => tryq(db, `select * from devotional_answers`));
ok('anonymous (no login) is denied on answers', !r.ok, r.err?.slice(0, 50));
for (const t of ['app_members', 'account_details', 'admin_audit_log', 'devotional_answer_revisions']) { r = await as(db, null, 'anon', () => tryq(db, `select * from ${t}`)); ok(`anonymous denied on ${t}`, !r.ok); }
r = await as(db, null, 'anon', () => tryq(db, `select public.wt_is_member()`)); ok('anonymous cannot call helper functions', !r.ok);
r = await as(db, S, 'authenticated', () => tryq(db, `select * from account_details`)); ok('non-member sees no account details', r.ok && r.rows.length === 0);

// --- admin/account tables: browsers cannot write ---
for (const [t, ins] of [['app_members', `insert into app_members(user_id,role) values ('${S}','member')`], ['account_details', `update account_details set username='hacker' where user_id='${C}'`], ['admin_audit_log', `insert into admin_audit_log(actor_id,action) values ('${H}','x')`]]) {
  for (const [who, uid] of [['Calista', C], ['Hunter', H]]) { r = await as(db, uid, 'authenticated', () => tryq(db, ins)); ok(`${who} cannot write ${t} from the browser`, !r.ok, r.err?.slice(0, 40)); }
}
await db.exec(`insert into admin_audit_log(actor_id,action,target_user_id,details) values ('${H}','test','${C}','{"field":"username"}')`);   // as superuser = stand-in for service role
ok('admin (Hunter) can read the audit log', (await as(db, H, 'authenticated', () => db.query(`select * from admin_audit_log`))).rows.length === 1);
ok('Calista cannot read the audit log', (await as(db, C, 'authenticated', () => db.query(`select * from admin_audit_log`))).rows.length === 0);
r = await tryq(db, `insert into admin_audit_log(actor_id,action,details) values ('${H}','x','{"password":"abc"}')`);
ok('audit log refuses entries containing a password field', !r.ok);
ok('members can read own membership only', (await as(db, C, 'authenticated', () => db.query(`select * from app_members`))).rows.length === 1);
r = await tryq(db, `insert into app_members(user_id,role) values ('${S}','admin')`); ok('only one admin can exist', !r.ok);

// --- existing behavior unchanged ---
ok('existing: signed-in user can still read devotional days (unchanged policy)', (await as(db, C, 'authenticated', () => db.query(`select * from devotional_days`))).rows.length === 16);
r = await as(db, C, 'authenticated', () => tryq(db, `update devotional_days set expanded_reflection='new expanded text' where id='${DAY2}'`));
ok('existing admin editing path can fill the NEW columns', r.ok && r.n === 1, r.err);
ok('...and the original Reflection text is untouched', (await db.query(`select simple_explanation s from devotional_days where id='${DAY2}'`)).rows[0].s === 'FAKE original reflection text for sample day 1.2.');
r = await as(db, C, 'authenticated', () => tryq(db, `delete from devotional_days where id='${DAY}'`));
ok('a day that has answers cannot be deleted (protects saved answers)', !r.ok, r.err?.slice(0, 60));
r = await as(db, null, 'anon', () => tryq(db, `select * from devotional_days`)); ok('existing: anonymous gets no devotional_days rows (denied or empty)', !r.ok || r.rows.length === 0);


// --- NEW in v2: forced password change is enforced by the database for new features ---
await db.exec(`update account_details set must_change_password = true where user_id = '${C}'`); // stand-in for the admin function
ok('flagged user (temp password) cannot read answers', (await as(db, C, 'authenticated', () => db.query('select * from devotional_answers'))).rows.length === 0);
r = await as(db, C, 'authenticated', () => tryq(db, `insert into devotional_answers(day_id,user_id,answer_text,status) values ('${DAY2}','${C}','x','draft')`));
ok('flagged user cannot write answers until the password is changed', !r.ok);
ok('flagged user can still read own account flag and own membership (so the app can send them to change it)',
  (await as(db, C, 'authenticated', () => db.query('select must_change_password from account_details'))).rows.length === 1 && (await as(db, C, 'authenticated', () => db.query('select * from app_members'))).rows.length === 1);
ok('the other person is unaffected while one is flagged', (await as(db, H, 'authenticated', sel)).length >= 1);
await db.exec(`update account_details set must_change_password = false where user_id = '${C}'`);
ok('after the change, access is restored', (await as(db, C, 'authenticated', sel)).length === 2);
r = await as(db, H, 'authenticated', () => tryq(db, `insert into devotional_answers(day_id,user_id,answer_text,status) values ('${dayId(1,3)}','${H}','${'x'.repeat(20001)}','draft')`));
ok('answers over 20,000 characters are refused', !r.ok);

// --- rollback script ---
const rb = fs.readFileSync(MIG + '005_rollback_new_objects_only.sql', 'utf8');
r = await tryq(db, rb.replace(/^begin;|commit;$/gm, '')).then(async x => x); // may not parse as single statement; use exec
let guard = null; try { await db.exec(rb); } catch (e) { guard = e.message; }
ok('rollback REFUSES to run while real answers/content exist', guard && /STOP/.test(guard), guard?.slice(0, 70));

// fresh DB: migrate then roll back with no data => back to original
const db2 = await build(); const b2 = await base(db2);
await db2.exec(mig); await db2.exec(rb);
const a2 = await base(db2);
ok('rollback on an unused migration restores the original exactly (all tables, policies, accounts)', JSON.stringify(b2) === JSON.stringify(a2));
const left = (await db2.query(`select count(*)::int n from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relname in ('app_members','devotional_answers','devotional_answer_revisions','account_details','admin_audit_log')`)).rows[0].n;
const cols = (await db2.query(`select count(*)::int n from information_schema.columns where table_name='devotional_days' and column_name in ('supporting_scripture_ref','understanding_text','expanded_reflection','closing_prayer','photo_caption','shared_memory')`)).rows[0].n;
ok('rollback leaves no new tables or columns behind', left === 0 && cols === 0);

// migration fails safe if a name is taken
const db3 = await build(); await db3.exec('create table public.app_members(x int)');
const b3pre = await base(db3);
let failed = false; try { await db3.exec(mig); } catch { failed = true; }
await db3.exec('rollback');
const b3 = await base(db3);
const newLeft = (await db3.query("select count(*)::int n from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relname in ('devotional_answers','account_details','admin_audit_log','devotional_answer_revisions')")).rows[0].n;
ok('migration aborts if any target name already exists, and leaves nothing behind', failed && JSON.stringify(b3pre) === JSON.stringify(b3) && newLeft === 0);

console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
