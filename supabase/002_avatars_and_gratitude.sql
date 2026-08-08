-- Run this once in Supabase: Project > SQL Editor > New query > paste > Run
-- Adds profile pictures (via Supabase Storage) and the gratitude journal
-- fields on the weekly check-in. Safe to run after the original schema.sql.

-- ---- Profile pictures ----

-- Stores the Storage object path (not a public URL) for each person's photo,
-- e.g. "3f2a...b1.jpg". Nullable so people without a photo just show initials.
alter table profiles add column if not exists avatar_url text;

-- profiles previously had no update policy at all (only select), so nobody
-- could set their own display name or avatar. This matches the same
-- "either of you can edit any row" trust model already used by every other
-- table in this schema.
create policy "authenticated update profiles" on profiles
  for update using (auth.role() = 'authenticated');

-- Private bucket (not public) so photos are only viewable when signed in,
-- served through short-lived signed URLs by the app.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do nothing;

create policy "authenticated read avatars" on storage.objects
  for select using (bucket_id = 'avatars' and auth.role() = 'authenticated');

create policy "authenticated upload avatars" on storage.objects
  for insert with check (bucket_id = 'avatars' and auth.role() = 'authenticated');

create policy "authenticated update avatars" on storage.objects
  for update using (bucket_id = 'avatars' and auth.role() = 'authenticated');

create policy "authenticated delete avatars" on storage.objects
  for delete using (bucket_id = 'avatars' and auth.role() = 'authenticated');

-- ---- Gratitude journal (folded into the weekly check-in) ----

alter table checkins add column if not exists gratitude_1 text;
alter table checkins add column if not exists gratitude_2 text;
alter table checkins add column if not exists gratitude_3 text;
