-- Run this once in Supabase: Project > SQL Editor > New query > paste > Run
-- Adds support for attaching a photo to each devotional day.

alter table devotional_days add column if not exists photo_url text;
alter table devotional_days add column if not exists photo_uploaded_by uuid references profiles(id);
alter table devotional_days add column if not exists photo_uploaded_at timestamptz;

-- Private bucket (not public), same model as the avatars bucket: only
-- viewable by the two of you, served through short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('devotional-photos', 'devotional-photos', false)
on conflict (id) do nothing;

create policy "authenticated read devotional photos" on storage.objects
  for select using (bucket_id = 'devotional-photos' and auth.role() = 'authenticated');

create policy "authenticated upload devotional photos" on storage.objects
  for insert with check (bucket_id = 'devotional-photos' and auth.role() = 'authenticated');

create policy "authenticated update devotional photos" on storage.objects
  for update using (bucket_id = 'devotional-photos' and auth.role() = 'authenticated');

create policy "authenticated delete devotional photos" on storage.objects
  for delete using (bucket_id = 'devotional-photos' and auth.role() = 'authenticated');
