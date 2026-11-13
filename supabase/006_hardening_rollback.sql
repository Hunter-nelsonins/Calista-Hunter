-- Rollback for 006: restores the EXACT original access rules (as in schema.sql, 002, 003) and grants.
-- Does not touch data, files, accounts or anything from migration 005. One transaction.
begin;

-- original table policies
drop policy "members read profiles"        on public.profiles;
drop policy "members update own profile"   on public.profiles;
drop policy "members all devotionals"      on public.devotionals;
drop policy "members all devotional_days"  on public.devotional_days;
drop policy "members all prayers"          on public.prayers;
drop policy "members all checkins"         on public.checkins;
drop policy "members all vision_entries"   on public.vision_entries;

create policy "authenticated read profiles" on profiles for select using (auth.role() = 'authenticated');
create policy "authenticated update profiles" on profiles for update using (auth.role() = 'authenticated');
create policy "authenticated all devotionals" on devotionals for all using (auth.role() = 'authenticated');
create policy "authenticated all devotional_days" on devotional_days for all using (auth.role() = 'authenticated');
create policy "authenticated all prayers" on prayers for all using (auth.role() = 'authenticated');
create policy "authenticated all checkins" on checkins for all using (auth.role() = 'authenticated');
create policy "authenticated all vision_entries" on vision_entries for all using (auth.role() = 'authenticated');

grant truncate, trigger, references on
  public.profiles, public.devotionals, public.devotional_days, public.prayers, public.checkins, public.vision_entries
  to authenticated;

-- original storage policies
drop policy "members read avatars"      on storage.objects;
drop policy "members add avatars"       on storage.objects;
drop policy "admin change avatars"      on storage.objects;
drop policy "admin remove avatars"      on storage.objects;
drop policy "members read day photos"   on storage.objects;
drop policy "members add day photos"    on storage.objects;
drop policy "admin change day photos"   on storage.objects;
drop policy "admin remove day photos"   on storage.objects;

create policy "authenticated read avatars" on storage.objects for select using (bucket_id = 'avatars' and auth.role() = 'authenticated');
create policy "authenticated upload avatars" on storage.objects for insert with check (bucket_id = 'avatars' and auth.role() = 'authenticated');
create policy "authenticated update avatars" on storage.objects for update using (bucket_id = 'avatars' and auth.role() = 'authenticated');
create policy "authenticated delete avatars" on storage.objects for delete using (bucket_id = 'avatars' and auth.role() = 'authenticated');
create policy "authenticated read devotional photos" on storage.objects for select using (bucket_id = 'devotional-photos' and auth.role() = 'authenticated');
create policy "authenticated upload devotional photos" on storage.objects for insert with check (bucket_id = 'devotional-photos' and auth.role() = 'authenticated');
create policy "authenticated update devotional photos" on storage.objects for update using (bucket_id = 'devotional-photos' and auth.role() = 'authenticated');
create policy "authenticated delete devotional photos" on storage.objects for delete using (bucket_id = 'devotional-photos' and auth.role() = 'authenticated');

commit;
