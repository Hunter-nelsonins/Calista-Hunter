-- READ-ONLY. Run right after migration 005 and compare with the baseline. Prints counts/checksums only.
-- The checksum for devotional_days is computed WITHOUT the six new columns, so it must equal the
-- pre-migration value (backup 2026-11-12: rows 41, md5 149aa558e19f413da2ade89fae8ece76).
select jsonb_build_object(
  'profiles',        jsonb_build_object('rows',(select count(*) from public.profiles),        'md5',md5((select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)::text from public.profiles t))),
  'devotionals',     jsonb_build_object('rows',(select count(*) from public.devotionals),     'md5',md5((select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)::text from public.devotionals t))),
  'devotional_days', jsonb_build_object('rows',(select count(*) from public.devotional_days),
                       'orphan_rows',(select count(*) from public.devotional_days where devotional_id is null),
                       'md5_original_columns',md5((select coalesce(jsonb_agg((to_jsonb(t) - array['supporting_scripture_ref','understanding_text','expanded_reflection','closing_prayer','photo_caption','shared_memory','main_reading_ref','looking_back_text','prayer_prompts']) order by t.id),'[]'::jsonb)::text from public.devotional_days t))),
  'prayers',         jsonb_build_object('rows',(select count(*) from public.prayers),         'md5',md5((select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)::text from public.prayers t))),
  'checkins',        jsonb_build_object('rows',(select count(*) from public.checkins),        'md5',md5((select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)::text from public.checkins t))),
  'vision_entries',  jsonb_build_object('rows',(select count(*) from public.vision_entries),  'md5',md5((select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)::text from public.vision_entries t))),
  'auth_users',      (select count(*) from auth.users),
  'storage_objects', (select jsonb_object_agg(bucket_id,n) from (select bucket_id,count(*) n from storage.objects where bucket_id in ('avatars','devotional-photos') group by 1) s),
  'existing_policy_count_unchanged', (select count(*) from pg_policies where schemaname='public' and tablename in ('profiles','devotionals','devotional_days','prayers','checkins','vision_entries')),  -- expect 7
  'new_tables_rls', (select jsonb_object_agg(tablename,rowsecurity) from pg_tables where schemaname='public' and tablename in ('app_members','devotional_answers','devotional_answer_revisions','account_details','admin_audit_log')),
  'anon_privileges_on_new_tables', (select count(*) from information_schema.role_table_grants where table_schema='public' and grantee='anon' and table_name in ('app_members','devotional_answers','devotional_answer_revisions','account_details','admin_audit_log')) -- expect 0
)::text as verify;
