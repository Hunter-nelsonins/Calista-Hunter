-- Rollback for 007: removes ONLY the three new columns. Refuses to run if any of them holds content,
-- so written work is never dropped by accident (export it first, then decide).
begin;
do $$
declare n bigint;
begin
  select count(*) into n from public.devotional_days
   where main_reading_ref is not null or looking_back_text is not null or prayer_prompts is not null;
  if n > 0 then raise exception 'STOP: % days contain content in the new fields; export it before any rollback', n; end if;
end $$;
alter table public.devotional_days drop column main_reading_ref, drop column looking_back_text, drop column prayer_prompts;
notify pgrst, 'reload schema';
commit;
