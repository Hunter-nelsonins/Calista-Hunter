// Migration 007: three new nullable fields. Existing data untouched; guards behave; rollback is safe.
import { createDb, SQL_DIR, HUNTER_ID, CALISTA_ID, STRANGER_ID, dayId, ORPHAN_DAY_ID } from '../db.mjs';
import fs from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  [' + String(x).slice(0, 70) + ']' : '')); };
const sql = f => fs.readFileSync(SQL_DIR + '/' + f, 'utf8');
const NEWCOLS = ['supporting_scripture_ref', 'understanding_text', 'expanded_reflection', 'closing_prayer', 'photo_caption', 'shared_memory', 'main_reading_ref', 'looking_back_text', 'prayer_prompts'];
const md5Orig = db => db.query(`select md5(jsonb_agg(to_jsonb(t) - array[${NEWCOLS.map(c => `'${c}'`).join(',')}] order by t.id)::text) m, count(*)::int n from public.devotional_days t`).then(r => r.rows[0]);
async function as(db, uid, fn) { await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false), set_config('request.jwt.claim.role','authenticated',false);`); try { return await fn(); } finally { await db.exec('reset role'); } }
const tryq = async (db, q) => { try { const r = await db.query(q); return { ok: true, rows: r.rows, n: r.affectedRows }; } catch (e) { return { ok: false, err: e.message }; } };

const db = await createDb({ migrate: false, stranger: true });
await db.exec(sql('005_additive_walk_together.sql')); await db.exec(sql('006_hardening_members_only.sql'));
const before = await md5Orig(db);
await db.exec(sql('007_expanded_content_fields.sql'));
ok('007 changes no existing data (original columns identical, 16 rows incl. orphan)', JSON.stringify(before) === JSON.stringify(await md5Orig(db)) && before.n === 16);
const cols = (await db.query(`select column_name, is_nullable, column_default from information_schema.columns where table_name='devotional_days' and column_name in ('main_reading_ref','looking_back_text','prayer_prompts')`)).rows;
ok('three new columns, all nullable with no default', cols.length === 3 && cols.every(c => c.is_nullable === 'YES' && c.column_default === null));
ok('orphan day untouched and new fields empty', (await db.query(`select count(*)::int n from devotional_days where id='${ORPHAN_DAY_ID}' and main_reading_ref is null and looking_back_text is null and prayer_prompts is null and closing_prayer is null`)).rows[0].n === 1);
let err = ''; try { await db.exec(sql('007_expanded_content_fields.sql')); } catch (e) { err = e.message; } await db.exec('rollback').catch(() => {});
ok('re-running 007 refuses (names already exist) and changes nothing', /Preflight failed/.test(err));
for (const [who, uid] of [['Hunter', HUNTER_ID], ['Calista', CALISTA_ID]]) {
  const r = await as(db, uid, () => tryq(db, `update devotional_days set main_reading_ref='John 3:16-21', looking_back_text='- a', prayer_prompts='- b' where id='${dayId(1, 2)}'`));
  ok(`${who} can fill the new fields through the existing editor path`, r.ok && r.n === 1, r.err);
  await db.exec(`update devotional_days set main_reading_ref=null, looking_back_text=null, prayer_prompts=null where id='${dayId(1, 2)}'`);
}
const s = await as(db, STRANGER_ID, () => tryq(db, `update devotional_days set prayer_prompts='x'`)); ok('a stranger cannot write the new fields', s.ok && s.n === 0);
await db.exec(`update devotional_days set prayer_prompts='- keep me' where id='${dayId(1, 3)}'`);
let guard = ''; try { await db.exec(sql('007_rollback_new_fields_only.sql')); } catch (e) { guard = e.message; } await db.exec('rollback').catch(() => {});
ok('rollback refuses while any new field holds content', /STOP/.test(guard));
await db.exec(`update devotional_days set prayer_prompts=null where id='${dayId(1, 3)}'`);
await db.exec(sql('007_rollback_new_fields_only.sql'));
ok('rollback with empty fields removes only the three columns and leaves data identical', JSON.stringify(before) === JSON.stringify(await md5Orig(db)) && (await db.query(`select count(*)::int n from information_schema.columns where table_name='devotional_days' and column_name in ('main_reading_ref','looking_back_text','prayer_prompts')`)).rows[0].n === 0);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
