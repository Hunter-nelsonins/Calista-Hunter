-- =====================================================================================
-- Walk Together · Migration 007 · three new OPTIONAL text fields on devotional_days · ADDITIVE ONLY
-- Needs 005 first. Adds nullable columns only: no data is read, changed or removed; no policy,
-- permission, account, storage or insurance object is touched. The existing "members all devotional_days"
-- rule already covers new columns, exactly as it does for the columns added in 005.
--   main_reading_ref  the longer main Bible reading (a reference; text comes from the Bible API)
--   looking_back_text "Looking Back Together" (evening reflection / activity)
--   prayer_prompts    "Take It to Prayer" (optional, personal prompts; nothing to write or confirm)
-- Plain CREATE/ADD (no "if not exists"): if a name is already taken the script fails and changes nothing.
-- =====================================================================================
begin;
do $$
begin
  if to_regclass('public.app_members') is null then raise exception 'Preflight failed: migration 005 is not applied'; end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='devotional_days'
        and column_name in ('main_reading_ref','looking_back_text','prayer_prompts')) <> 0 then
    raise exception 'Preflight failed: one of the new column names already exists';
  end if;
end $$;

alter table public.devotional_days
  add column main_reading_ref  text,
  add column looking_back_text text,
  add column prayer_prompts    text;

notify pgrst, 'reload schema';
commit;
