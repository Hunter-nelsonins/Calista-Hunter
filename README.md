# Walk Together

A private devotional and prayer site for the two of you. Astro frontend, Supabase for
auth and data, deployed on Netlify.

## What's already built

- Verse of the day, pulled live from bible-api.com (World English Bible, public domain, no key needed)
- Weekly devotionals split into daily chunks, laid out as a "road" of stepping stones
- Prayer log: add requests, check off answered, see who added and who marked it answered
- Shared, editable relationship vision page (values + keeping God first) with history
- Weekly check in log
- Simple two person login through Supabase Auth

## One time setup

1. **Create a Supabase project.** Go to supabase.com, create a free project, and wait
   for it to finish provisioning.

2. **Run the schema.** Open Project > SQL Editor > New query, paste in the entire
   contents of `supabase/schema.sql`, and click Run. This creates every table, the
   security rules that keep your data private to just the two of you, and an automatic
   profile row whenever someone signs up.

3. **Create your two accounts.** Go to Authentication > Users > Add user in the
   Supabase dashboard. Add both of your emails with a password each. Do this for both
   of you now, since there's no public sign up page on the site itself, on purpose.

4. **Set display names.** After creating each user, go to Table Editor > profiles and
   fill in the `display_name` column for each row (this is what shows up next to
   prayers, check ins, and vision edits).

5. **Get your API keys.** Go to Project Settings > API. Copy the Project URL and the
   `anon public` key.

6. **Set environment variables.** Copy `.env.example` to `.env` and paste in the values
   from step 5. When you deploy to Netlify, add the same two variables under
   Site configuration > Environment variables.

7. **Push this project to a GitHub repo**, then in Netlify choose "Import from Git" and
   point it at the repo. Netlify will detect the Astro + Netlify adapter setup
   automatically.

8. **Point your domain at the Netlify site** under Domain management once it's live.

## Adding devotional content

There's no admin UI yet on purpose, since it's just the two of you writing this
content, not managing it through a form. Add rows directly in Supabase:

- One row in `devotionals` per week (title, passage reference, theme, week_start date,
  discussion prompt)
- One row in `devotional_days` per day of that week (day_number 1 through however many
  days, title, simple_explanation, daily_application, daily_question), each linked to
  the devotional's id

Claude Code can help you draft this content in your voice, but read every entry before
it goes live since this is scripture teaching for the two of you, not something to
publish unread.

## Local development

```
npm install
npm run dev
```

## What's intentionally left out for now

- No password reset flow (with two users, just reset it from the Supabase dashboard)
- No image uploads
- No email notifications for new prayers or check ins

All straightforward to add later once the core is working the way you want it.
