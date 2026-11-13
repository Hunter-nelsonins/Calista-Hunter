-- =====================================================================================
-- Rollback for migration 005. PROPOSED, NOT APPLIED. Removes ONLY objects that 005 created.
-- It never touches any original Walk Together table's existing columns/rows, storage, auth, or insurance.
--
-- SAFETY GATE: it refuses to run if anyone has already saved real data in the new objects
-- (answers, revisions, usernames, audit entries, new content/caption columns). Dropping those would
-- destroy work, so in that case it stops and tells you to export first. Do not weaken this guard
-- without a deliberate decision.
-- =====================================================================================
begin;

do $$
declare n bigint;
begin
  select count(*) into n from public.devotional_answers;          if n > 0 then raise exception 'STOP: % saved answers exist; export them before any rollback', n; end if;
  select count(*) into n from public.devotional_answer_revisions; if n > 0 then raise exception 'STOP: % answer revisions exist; export them first', n; end if;
  select count(*) into n from public.account_details where username is not null or must_change_password;
                                                                   if n > 0 then raise exception 'STOP: account details have been filled in; export first'; end if;
  select count(*) into n from public.admin_audit_log;             if n > 0 then raise exception 'STOP: audit log has entries; export it first'; end if;
  select count(*) into n from public.devotional_days
   where supporting_scripture_ref is not null or understanding_text is not null or expanded_reflection is not null
      or closing_prayer is not null or photo_caption is not null or shared_memory is not null;
                                                                   if n > 0 then raise exception 'STOP: % days have new content/caption; export first', n; end if;
end $$;

drop table public.admin_audit_log;
drop table public.account_details;
drop trigger wt_devotional_answers_guard on public.devotional_answers;
drop table public.devotional_answer_revisions;
drop table public.devotional_answers;
drop function public.wt_devotional_answers_guard();
drop function public.wt_i_have_submitted(uuid);
drop table public.app_members;
drop function public.wt_is_member();
drop function public.wt_is_admin();

alter table public.devotional_days
  drop column supporting_scripture_ref,
  drop column understanding_text,
  drop column expanded_reflection,
  drop column closing_prayer,
  drop column photo_caption,
  drop column shared_memory;

notify pgrst, 'reload schema';
commit;
