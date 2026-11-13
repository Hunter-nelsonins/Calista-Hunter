-- =====================================================================================
-- Walk Together · Migration 006 · privacy hardening (H1-H4) · requires 005 first
-- Approved by Hunter. Changes ONLY access rules for the six Walk Together tables and the two Walk
-- Together storage buckets. No rows, files, accounts, auth settings or Nelson Insurance objects are touched.
-- One transaction: new rules are created BEFORE the old ones are removed, so there is never a gap.
-- The exact original rules are restored by 006_hardening_rollback.sql.
--
--  H1  signed-in users lose TRUNCATE / TRIGGER / REFERENCES on the six tables (the app never uses them)
--  H2  the six tables are limited to the two members (public.wt_is_member())
--  H3  profile edits limited to your own row
--  H4  photo buckets: members can read and add; only the admin can change or delete stored files
-- =====================================================================================
begin;

-- Preflight: refuse to run unless 005 is in place and the exact old rules we are replacing are present.
do $$
begin
  if to_regclass('public.app_members') is null or to_regprocedure('public.wt_is_member()') is null then
    raise exception 'Preflight failed: migration 005 has not been applied';
  end if;
  if (select count(*) from public.app_members where user_id in ('e6db6091-ffd7-49d0-87a6-63d8b516c93a','31d35809-75f0-4de5-ba5c-5902068d73e6')) <> 2 then
    raise exception 'Preflight failed: allowlist does not contain both accounts';
  end if;
  if (select count(*) from pg_policies where schemaname='public' and policyname in (
        'authenticated read profiles','authenticated update profiles','authenticated all devotionals',
        'authenticated all devotional_days','authenticated all prayers','authenticated all checkins','authenticated all vision_entries')) <> 7 then
    raise exception 'Preflight failed: the seven original table policies are not exactly as expected';
  end if;
  if (select count(*) from pg_policies where schemaname='storage' and tablename='objects' and policyname in (
        'authenticated read avatars','authenticated upload avatars','authenticated update avatars','authenticated delete avatars',
        'authenticated read devotional photos','authenticated upload devotional photos','authenticated update devotional photos','authenticated delete devotional photos')) <> 8 then
    raise exception 'Preflight failed: the eight original storage policies are not exactly as expected';
  end if;
end $$;

-- ---- H1: remove powers the app never uses ----
revoke truncate, trigger, references on
  public.profiles, public.devotionals, public.devotional_days, public.prayers, public.checkins, public.vision_entries
  from authenticated;

-- ---- H2 / H3: new member-only rules on the six tables (created first) ----
create policy "members read profiles" on public.profiles
  for select to authenticated using (public.wt_is_member());
create policy "members update own profile" on public.profiles
  for update to authenticated
  using      (public.wt_is_member() and id = (select auth.uid()))
  with check (public.wt_is_member() and id = (select auth.uid()));

create policy "members all devotionals"     on public.devotionals      for all to authenticated using (public.wt_is_member()) with check (public.wt_is_member());
create policy "members all devotional_days" on public.devotional_days  for all to authenticated using (public.wt_is_member()) with check (public.wt_is_member());
create policy "members all prayers"         on public.prayers          for all to authenticated using (public.wt_is_member()) with check (public.wt_is_member());
create policy "members all checkins"        on public.checkins         for all to authenticated using (public.wt_is_member()) with check (public.wt_is_member());
create policy "members all vision_entries"  on public.vision_entries   for all to authenticated using (public.wt_is_member()) with check (public.wt_is_member());

-- ...then the old "any signed-in user" rules are removed (same transaction, no gap)
drop policy "authenticated read profiles"      on public.profiles;
drop policy "authenticated update profiles"    on public.profiles;
drop policy "authenticated all devotionals"    on public.devotionals;
drop policy "authenticated all devotional_days" on public.devotional_days;
drop policy "authenticated all prayers"        on public.prayers;
drop policy "authenticated all checkins"       on public.checkins;
drop policy "authenticated all vision_entries" on public.vision_entries;

-- ---- H4: the two Walk Together photo buckets (insurance buckets' policies are not touched) ----
create policy "members read avatars"  on storage.objects for select to authenticated using (bucket_id = 'avatars' and public.wt_is_member());
create policy "members add avatars"   on storage.objects for insert to authenticated with check (bucket_id = 'avatars' and public.wt_is_member());
create policy "admin change avatars"  on storage.objects for update to authenticated using (bucket_id = 'avatars' and public.wt_is_admin()) with check (bucket_id = 'avatars' and public.wt_is_admin());
create policy "admin remove avatars"  on storage.objects for delete to authenticated using (bucket_id = 'avatars' and public.wt_is_admin());

create policy "members read day photos"  on storage.objects for select to authenticated using (bucket_id = 'devotional-photos' and public.wt_is_member());
create policy "members add day photos"   on storage.objects for insert to authenticated with check (bucket_id = 'devotional-photos' and public.wt_is_member());
create policy "admin change day photos"  on storage.objects for update to authenticated using (bucket_id = 'devotional-photos' and public.wt_is_admin()) with check (bucket_id = 'devotional-photos' and public.wt_is_admin());
create policy "admin remove day photos"  on storage.objects for delete to authenticated using (bucket_id = 'devotional-photos' and public.wt_is_admin());

drop policy "authenticated read avatars"           on storage.objects;
drop policy "authenticated upload avatars"         on storage.objects;
drop policy "authenticated update avatars"         on storage.objects;
drop policy "authenticated delete avatars"         on storage.objects;
drop policy "authenticated read devotional photos"   on storage.objects;
drop policy "authenticated upload devotional photos" on storage.objects;
drop policy "authenticated update devotional photos" on storage.objects;
drop policy "authenticated delete devotional photos" on storage.objects;

commit;
