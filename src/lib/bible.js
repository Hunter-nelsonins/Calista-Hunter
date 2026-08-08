// Free, public domain, no API key needed. Defaults to the World English Bible.
const VERSE_POOL = [
  'John 3:16', 'Romans 8:28', 'Philippians 4:6-7', 'Matthew 6:33',
  'Ephesians 4:2-3', '1 Corinthians 13:4-7', 'Colossians 3:14',
  'James 1:2-4', 'Galatians 5:22-23', 'Romans 12:9-10',
  '1 Peter 5:7', 'Hebrews 10:24-25', 'Philippians 2:3-4',
  'Ephesians 5:25', 'Proverbs 3:5-6',
];

// Deterministic pick so it changes daily but is the same for both of you on the same day
function pickForToday(pool) {
  const day = Math.floor(Date.now() / 86400000);
  return pool[day % pool.length];
}

export async function getVerseOfTheDay() {
  const ref = pickForToday(VERSE_POOL);
  const res = await fetch(`https://bible-api.com/${encodeURIComponent(ref)}?translation=web`);
  if (!res.ok) {
    return { reference: ref, text: 'Could not load verse text right now.' };
  }
  const data = await res.json();
  return { reference: data.reference, text: data.text.trim() };
}

export async function getPassage(ref) {
  const res = await fetch(`https://bible-api.com/${encodeURIComponent(ref)}?translation=web`);
  if (!res.ok) return null;
  const data = await res.json();
  return { reference: data.reference, text: data.text.trim() };
}
