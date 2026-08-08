-- Run this whole file once in Supabase: Project > SQL Editor > New query > paste > Run

-- Simple display names for the two of you, tied to Supabase Auth users
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null
);

-- Weekly devotional study (a passage/theme covering New Testament content)
create table devotionals (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  passage_ref text not null,
  theme text,
  week_start date not null,
  discussion_prompt text,
  created_at timestamptz default now()
);

-- Each week is split into daily chunks
create table devotional_days (
  id uuid primary key default gen_random_uuid(),
  devotional_id uuid references devotionals(id) on delete cascade,
  day_number int not null,
  title text not null,
  simple_explanation text not null,
  daily_application text not null,
  daily_question text,
  created_at timestamptz default now()
);

-- Prayer log, with who added it and who marked it answered
create table prayers (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  added_by uuid references profiles(id),
  is_answered boolean default false,
  answered_by uuid references profiles(id),
  answered_at timestamptz,
  created_at timestamptz default now()
);

-- Weekly check ins, one row per person per week
create table checkins (
  id uuid primary key default gen_random_uuid(),
  submitted_by uuid references profiles(id),
  week_start date not null,
  walk_with_god text,
  relationship_note text,
  prayer_needs text,
  created_at timestamptz default now()
);

-- Shared, editable relationship vision (single evolving row, with history)
create table vision_entries (
  id uuid primary key default gen_random_uuid(),
  values_statement text,
  keeping_god_first text,
  edited_by uuid references profiles(id),
  created_at timestamptz default now()
);

-- Row Level Security: only the two logged in users can read or write, nobody else
alter table profiles enable row level security;
alter table devotionals enable row level security;
alter table devotional_days enable row level security;
alter table prayers enable row level security;
alter table checkins enable row level security;
alter table vision_entries enable row level security;

create policy "authenticated read profiles" on profiles for select using (auth.role() = 'authenticated');
create policy "authenticated all devotionals" on devotionals for all using (auth.role() = 'authenticated');
create policy "authenticated all devotional_days" on devotional_days for all using (auth.role() = 'authenticated');
create policy "authenticated all prayers" on prayers for all using (auth.role() = 'authenticated');
create policy "authenticated all checkins" on checkins for all using (auth.role() = 'authenticated');
create policy "authenticated all vision_entries" on vision_entries for all using (auth.role() = 'authenticated');

-- Auto create a profile row whenever someone signs up
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
