// LOCAL-ONLY. Builds an in-memory Postgres that looks like the Walk Together part of Supabase:
// the real migrations 1-4 (+ proposed 005), Supabase-style roles/permissions, and FAKE data.
// Nothing here ever talks to the real Supabase project.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SQL_DIR = path.resolve(here, '../supabase');

export const HUNTER_ID = 'e6db6091-ffd7-49d0-87a6-63d8b516c93a';
export const CALISTA_ID = '31d35809-75f0-4de5-ba5c-5902068d73e6';
export const STRANGER_ID = '99999999-0000-4000-8000-000000000009';

// Fake local-only logins. Never valid anywhere else.
export const TEST_USERS = [
  { id: HUNTER_ID, email: 'hunter@example.test', password: 'LocalTest-Hunter-1!', name: 'Hunter' },
  { id: CALISTA_ID, email: 'calista@example.test', password: 'LocalTest-Calista-1!', name: 'Calista' },
  { id: STRANGER_ID, email: 'stranger@example.test', password: 'LocalTest-Stranger-1!', name: 'Stranger' },
];

const WEEK_IDS = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003'];
export const dayId = (w, d) => `bbbbbbbb-000${w}-4000-8000-00000000000${d}`;
export const ORPHAN_DAY_ID = 'bbbbbbbb-0000-4000-8000-0000000000ff';

export async function createDb({ migrate = true, fake = true, stranger = false, harden = true, afterMigrate = null } = {}) {
  // Return dates/timestamps as text in the same shape Supabase's API uses ("2026-08-12", "2026-08-08T15:00:00+00:00").
  const pad = v => (typeof v === 'string' ? v : String(v));
  const db = new PGlite({ parsers: {
    1082: v => pad(v),
    1114: v => pad(v).replace(' ', 'T'),
    1184: v => pad(v).replace(' ', 'T').replace(/([+-][0-9]{2})$/, '$1:00'),
  } });
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema storage;
    grant usage on schema public, auth, storage to anon, authenticated, service_role;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true),''),'anon') $$;
    create table storage.buckets (id text primary key, name text, public boolean);
    create table storage.objects (bucket_id text, name text, owner uuid, created_at timestamptz default now());
    alter table storage.objects enable row level security;   -- as in real Supabase
    grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role, public;
  `);
  // The existing production schema, in order (pre-005 state).
  for (const f of ['schema.sql', '002_avatars_and_gratitude.sql', '003_devotional_day_photos.sql', '004_devotional_day_scripture.sql'])
    await db.exec(fs.readFileSync(path.join(SQL_DIR, f), 'utf8'));
  // Mimic production: the 6 original tables are NOT granted to anon (verified on the real project).
  await db.exec(`revoke all on public.profiles, public.devotionals, public.devotional_days, public.prayers, public.checkins, public.vision_entries from anon;`);

  const users = TEST_USERS.filter(u => stranger || u.id !== STRANGER_ID);
  for (const u of users) await db.query(`insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)`, [u.id, u.email, JSON.stringify({ display_name: u.name })]);
  // the signup trigger created profiles from raw_user_meta_data

  if (fake) await seedFakeData(db);
  if (migrate) await db.exec(fs.readFileSync(path.join(SQL_DIR, '005_additive_walk_together.sql'), 'utf8'));
  if (migrate && harden) await db.exec(fs.readFileSync(path.join(SQL_DIR, '006_hardening_members_only.sql'), 'utf8'));
  if (migrate) await db.exec(fs.readFileSync(path.join(SQL_DIR, '007_expanded_content_fields.sql'), 'utf8'));
  if (afterMigrate) await afterMigrate(db);
  return db;
}

async function seedFakeData(db) {
  const weeks = [
    ['Week 1: Sample Theme One', 'John 3:16-17', '2026-08-12'],
    ['Week 2: Sample Theme Two', 'James 1:19-27', '2026-08-19'],
    ['Week 3: Sample Theme Three', 'Psalm 23:1-6', '2026-08-26'],
  ];
  for (let i = 0; i < weeks.length; i++) {
    await db.query(`insert into devotionals(id,title,passage_ref,theme,week_start,discussion_prompt) values ($1,$2,$3,'Fake sample theme',$4,'Fake weekly discussion prompt (test data)')`,
      [WEEK_IDS[i], weeks[i][0], weeks[i][1], weeks[i][2]]);
  }
  const refs = [['John 3:16', 'Romans 8:28', 'Philippians 4:6-7', 'Matthew 6:33', 'Proverbs 3:5-6'],
                ['James 1:19', 'Ephesians 4:26', 'Proverbs 18:21', 'Ecclesiastes 3:7', 'Proverbs 16:24'],
                ['Psalm 23:1-3', 'Psalm 23:4', 'Psalm 23:5', 'Psalm 23:6', 'Psalm 27:14']];
  for (let w = 1; w <= 3; w++) for (let d = 1; d <= 5; d++) {
    await db.query(`insert into devotional_days(id,devotional_id,day_number,title,simple_explanation,daily_application,daily_question,scripture_ref)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [dayId(w, d), WEEK_IDS[w - 1], d, `Sample Day ${w}.${d} Title`, `FAKE original reflection text for sample day ${w}.${d}.`,
       `FAKE original application for sample day ${w}.${d}.`, `FAKE talk-together question for sample day ${w}.${d}?`, refs[w - 1][d - 1]]);
  }
  // an orphan day (no week), like production
  await db.query(`insert into devotional_days(id,devotional_id,day_number,title,simple_explanation,daily_application,daily_question)
    values ($1,null,1,'Fake orphan day','orphan reflection','orphan application','orphan question?')`, [ORPHAN_DAY_ID]);
  // fake photos on two days (files are generated by the server; not real photos)
  await db.query(`update devotional_days set photo_url='fake-photo-1.svg', photo_uploaded_by=$1, photo_uploaded_at='2026-08-08T15:00:00Z' where id=$2`, [HUNTER_ID, dayId(1, 1)]);
  await db.query(`update devotional_days set photo_url='fake-photo-2.svg', photo_uploaded_by=$1, photo_uploaded_at='2026-08-25T15:00:00Z' where id=$2`, [CALISTA_ID, dayId(2, 2)]);
  await db.query(`insert into storage.objects(bucket_id,name) values ('devotional-photos','fake-photo-1.svg'),('devotional-photos','fake-photo-2.svg')`);
  await db.query(`insert into prayers(content,added_by) values ('FAKE prayer request one (test data)',$1),('FAKE prayer request two (test data)',$2)`, [HUNTER_ID, CALISTA_ID]);
  await db.query(`insert into vision_entries(values_statement,keeping_god_first,edited_by) values ('FAKE vision values v1','FAKE keeping god first v1',$1),('FAKE vision values v2','FAKE keeping god first v2',$2)`, [HUNTER_ID, CALISTA_ID]);
  await db.query(`insert into checkins(submitted_by,week_start,walk_with_god,relationship_note,prayer_needs) values ($1,'2026-08-24','FAKE walk with God','FAKE relationship note','FAKE prayer needs')`, [HUNTER_ID]);
}

// The expanded-content sample is applied AFTER migration 005 (the columns exist only then).
export async function seedExpandedSample(db) {
  await db.query(`update public.devotional_days set
      supporting_scripture_ref='Proverbs 18:13',
      understanding_text=$1, expanded_reflection=$2, closing_prayer=$3
    where id=$4`, [
    'James, most likely the brother of Jesus, wrote to believers scattered across the Roman world who were under real pressure. (FAKE test copy of the approved sample.)\n\nSwift to hear, slow to speak, slow to anger comes from the Old Testament wisdom tradition.\n\nJames wrote to a community, not to a couple; the principle still reaches every close relationship.',
    'Most arguments get worse because one of us stopped listening halfway through. (FAKE test copy.)\n\nListening is also how we grow closer to God.\n\nSlowness is a gift in hard moments.\n\nNone of this is about being perfect.',
    'Lord, slow our tongues and open our ears. In Jesus’ name, amen. (FAKE test copy.)',
    dayId(2, 1)]);
}
