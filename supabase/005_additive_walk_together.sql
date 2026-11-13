-- =====================================================================================
-- Walk Together · Migration 005 (v2) · ADDITIVE ONLY · PROPOSED, NOT APPLIED ANYWHERE
-- Project: hyvzltxfrryhlnycchna (shared with Nelson Insurance)
--
-- What this does:  adds new tables, nullable columns, indexes, functions, and narrow policies.
-- What it never does: no DROP, no TRUNCATE, no DELETE, no UPDATE of existing rows, no change to
--   any existing policy, grant, trigger, storage bucket, auth setting, or insurance object.
-- Every CREATE below is deliberately NOT "if not exists": if any name is already taken, the
--   whole script fails and rolls back instead of silently reusing/replacing something.
-- Runs as ONE transaction: if any statement fails, nothing is applied.
--
-- v2 changes after security review:
--   * answers have a 20,000-character limit
--   * a person flagged "must change password" (temporary-password reset) is treated as NOT a member
--     by every NEW table until they set their own password (server-side enforcement, not just a redirect)
--   * account_details is created before the helper functions that read it
-- =====================================================================================
begin;

-- ---------------------------------------------------------------------------------
-- 0. Preflight guard: abort unless both known accounts exist (no data is touched).
-- ---------------------------------------------------------------------------------
do $$
begin
  if (select count(*) from auth.users
       where id in ('e6db6091-ffd7-49d0-87a6-63d8b516c93a','31d35809-75f0-4de5-ba5c-5902068d73e6')) <> 2 then
    raise exception 'Preflight failed: the two Walk Together auth accounts were not both found';
  end if;
  if (select count(*) from public.profiles
       where id in ('e6db6091-ffd7-49d0-87a6-63d8b516c93a','31d35809-75f0-4de5-ba5c-5902068d73e6')) <> 2 then
    raise exception 'Preflight failed: the two Walk Together profiles were not both found';
  end if;
end $$;

-- ---------------------------------------------------------------------------------
-- 1. WHO MAY USE THE NEW FEATURES: a two-row allowlist (Hunter = admin, Calista = member).
--    All NEW tables check this list, so a stranger who somehow signed up gets nothing new.
--    Browsers can only read their own membership row. They cannot change this table.
-- ---------------------------------------------------------------------------------
create table public.app_members (
  user_id    uuid primary key references auth.users(id) on delete restrict,
  role       text not null check (role in ('admin','member')),
  created_at timestamptz not null default now()
);
create unique index app_members_single_admin on public.app_members (role) where role = 'admin';

alter table public.app_members enable row level security;
revoke all on public.app_members from anon, authenticated;
grant select on public.app_members to authenticated;
create policy "members read own membership" on public.app_members
  for select to authenticated using (user_id = (select auth.uid()));

insert into public.app_members (user_id, role) values
  ('e6db6091-ffd7-49d0-87a6-63d8b516c93a', 'admin'),   -- Hunter
  ('31d35809-75f0-4de5-ba5c-5902068d73e6', 'member');  -- Calista

-- ---------------------------------------------------------------------------------
-- 2. ACCOUNT DETAILS (usernames + forced-password-change flag). Written ONLY by the
--    server-side admin function (service role). Browsers can read, never write.
--    Usernames start empty: nothing is invented and no existing account is changed.
-- ---------------------------------------------------------------------------------
create table public.account_details (
  user_id              uuid primary key references auth.users(id) on delete restrict,
  username             text,
  must_change_password boolean not null default false,
  updated_at           timestamptz not null default now(),
  constraint account_details_username_format check (username is null or username ~ '^[a-z0-9._-]{3,30}$')
);
create unique index account_details_username_unique on public.account_details (lower(username)) where username is not null;

insert into public.account_details (user_id)
  select user_id from public.app_members;

-- ---------------------------------------------------------------------------------
-- 3. Helper functions. SECURITY DEFINER so policies can consult the allowlist without
--    recursion; search_path is pinned to '' and every name is schema-qualified.
--    "Member" = on the allowlist AND not in the middle of a forced password change.
-- ---------------------------------------------------------------------------------
create function public.wt_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.app_members m
      left join public.account_details a on a.user_id = m.user_id
     where m.user_id = (select auth.uid())
       and coalesce(a.must_change_password, false) = false)
$$;

create function public.wt_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.app_members m
      left join public.account_details a on a.user_id = m.user_id
     where m.user_id = (select auth.uid())
       and m.role = 'admin'
       and coalesce(a.must_change_password, false) = false)
$$;

revoke all on function public.wt_is_member() from public, anon;
revoke all on function public.wt_is_admin()  from public, anon;
grant execute on function public.wt_is_member() to authenticated;
grant execute on function public.wt_is_admin()  to authenticated;

alter table public.account_details enable row level security;
revoke all on public.account_details from anon, authenticated;
grant select on public.account_details to authenticated;
-- You can always read your own row (so the app can see the "must change password" flag)...
create policy "read own account details" on public.account_details
  for select to authenticated using (user_id = (select auth.uid()));
-- ...and active members can read both (so usernames can be shown).
create policy "members read account details" on public.account_details
  for select to authenticated using (public.wt_is_member());

-- ---------------------------------------------------------------------------------
-- 4. NEW OPTIONAL CONTENT + PHOTO COLUMNS on the existing devotional_days table.
--    All nullable, no defaults: existing rows (including the orphan row) keep every existing
--    value byte-for-byte and simply have NULL in the new columns. The original Scripture,
--    Reflection (simple_explanation), Apply It Today (daily_application), and Talk Together
--    (daily_question) columns are not touched. The existing "authenticated all
--    devotional_days" policy continues to cover these columns, same as the admin editor today.
-- ---------------------------------------------------------------------------------
alter table public.devotional_days
  add column supporting_scripture_ref text,   -- optional supporting passage reference (e.g. "Proverbs 18:13")
  add column understanding_text       text,   -- "Understanding the Scripture"
  add column expanded_reflection      text,   -- shown below the original Reflection, never instead of it
  add column closing_prayer           text,   -- "Pray Together"
  add column photo_caption            text,   -- optional caption for the day's main photo
  add column shared_memory            text;   -- optional shared memory about the day

-- ---------------------------------------------------------------------------------
-- 5. PRIVATE DAILY ANSWERS (new table; the weekly checkins table is not touched).
--    One row per person per devotional day, answering that day's existing Talk Together question.
-- ---------------------------------------------------------------------------------
create table public.devotional_answers (
  id           uuid primary key default gen_random_uuid(),
  day_id       uuid not null references public.devotional_days(id) on delete restrict,
  user_id      uuid not null references public.profiles(id)        on delete restrict,
  answer_text  text not null default '',
  status       text not null default 'draft' check (status in ('draft','submitted')),
  submitted_at timestamptz,
  edited_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint devotional_answers_one_per_person_per_day unique (day_id, user_id),
  constraint devotional_answers_submitted_has_time check (status = 'draft' or submitted_at is not null),
  constraint devotional_answers_submit_needs_text  check (status = 'draft' or length(btrim(answer_text)) > 0),
  constraint devotional_answers_length             check (length(answer_text) <= 20000)
);
create index devotional_answers_user_idx on public.devotional_answers (user_id);

-- Earlier versions of a submitted answer that was later edited. Written only by the trigger below.
create table public.devotional_answer_revisions (
  id          uuid primary key default gen_random_uuid(),
  answer_id   uuid not null references public.devotional_answers(id) on delete restrict,
  user_id     uuid not null,
  answer_text text not null,
  saved_at    timestamptz not null default now()
);
create index devotional_answer_revisions_answer_idx on public.devotional_answer_revisions (answer_id);

-- Reveal rule helper: "have I submitted for this day?" Reads the table past RLS on purpose, and
-- only ever answers about the CALLER (auth.uid()), so it leaks nothing about anyone else.
create function public.wt_i_have_submitted(p_day uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.devotional_answers
     where day_id = p_day and user_id = (select auth.uid()) and status = 'submitted')
$$;
revoke all on function public.wt_i_have_submitted(uuid) from public, anon;
grant execute on function public.wt_i_have_submitted(uuid) to authenticated;

-- Integrity trigger: the server (not the browser) decides timestamps, keeps submitted answers
-- submitted (no "un-submit" to hide a revealed answer), and preserves old text when edited.
create function public.wt_devotional_answers_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at   := now();
    new.updated_at   := now();
    new.edited_at    := null;
    new.submitted_at := case when new.status = 'submitted' then now() else null end;
    return new;
  end if;

  -- UPDATE
  if new.id <> old.id or new.day_id <> old.day_id or new.user_id <> old.user_id then
    raise exception 'day_id and user_id of an answer cannot be changed';
  end if;
  if old.status = 'submitted' and new.status = 'draft' then
    raise exception 'A submitted answer cannot be changed back to a draft';
  end if;
  new.created_at := old.created_at;
  if old.status = 'draft' and new.status = 'submitted' then
    new.submitted_at := now();
  else
    new.submitted_at := old.submitted_at;
  end if;
  new.edited_at := old.edited_at;
  if old.status = 'submitted' and new.answer_text is distinct from old.answer_text then
    insert into public.devotional_answer_revisions (answer_id, user_id, answer_text)
    values (old.id, old.user_id, old.answer_text);
    new.edited_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.wt_devotional_answers_guard() from public, anon, authenticated;

create trigger wt_devotional_answers_guard
  before insert or update on public.devotional_answers
  for each row execute function public.wt_devotional_answers_guard();

alter table public.devotional_answers          enable row level security;
alter table public.devotional_answer_revisions enable row level security;

revoke all on public.devotional_answers          from anon, authenticated;
revoke all on public.devotional_answer_revisions from anon, authenticated;
grant select, insert, update on public.devotional_answers to authenticated;   -- note: NO delete
grant select                 on public.devotional_answer_revisions to authenticated;

-- You can always read your own answers (drafts included)...
create policy "read own answers" on public.devotional_answers
  for select to authenticated
  using (user_id = (select auth.uid()) and public.wt_is_member());

-- ...and you can read the OTHER person's answer only if it is submitted AND you have submitted too.
-- Anything else is simply not returned by the database, so it can't be fetched through the API.
create policy "read partner answer after both submitted" on public.devotional_answers
  for select to authenticated
  using (public.wt_is_member()
         and user_id <> (select auth.uid())
         and status = 'submitted'
         and public.wt_i_have_submitted(day_id));

create policy "write own answers" on public.devotional_answers
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.wt_is_member());

create policy "edit own answers" on public.devotional_answers
  for update to authenticated
  using      (user_id = (select auth.uid()) and public.wt_is_member())
  with check (user_id = (select auth.uid()) and public.wt_is_member());

create policy "read own answer revisions" on public.devotional_answer_revisions
  for select to authenticated
  using (user_id = (select auth.uid()) and public.wt_is_member());

-- ---------------------------------------------------------------------------------
-- 6. ADMIN AUDIT LOG: who changed what, when. Cannot hold secrets (blocked by a check).
--    Written only by the admin Edge Function; only the admin can read it.
-- ---------------------------------------------------------------------------------
create table public.admin_audit_log (
  id             bigint generated always as identity primary key,
  actor_id       uuid not null,
  action         text not null,
  target_user_id uuid,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint admin_audit_no_secrets check (not (details ?| array['password','new_password','temporary_password','token','secret','key']))
);
create index admin_audit_log_created_idx on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from anon, authenticated;
grant select on public.admin_audit_log to authenticated;
create policy "admin reads audit log" on public.admin_audit_log
  for select to authenticated using (public.wt_is_admin());

-- Ask the API layer to pick up the new tables/columns right away.
notify pgrst, 'reload schema';

commit;
