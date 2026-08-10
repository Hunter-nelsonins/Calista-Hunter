-- Run this once in Supabase: Project > SQL Editor > New query > paste > Run
-- Adds a scripture passage reference to each individual devotional day
-- (e.g. "Luke 24:13-16"), separate from the week-level passage_ref already
-- on devotionals. No RLS changes needed - the existing "authenticated all
-- devotional_days" policy already covers this new column.

alter table devotional_days add column if not exists scripture_ref text;
