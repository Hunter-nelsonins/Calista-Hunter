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

// Saved scripture_ref values are free text, and some include the verse itself and/or a
// translation tag, e.g.
//   1 Corinthians 13:4-5 — "Charity suffereth long, and is kind..."
//   Ephesians 2:10 (KJV) — "For we are his workmanship..."
//   Day 2: Deuteronomy 30:19 — "I call heaven and earth..."
// The Bible API only understands a bare reference, so pull that out (and keep any quoted
// text as a fallback). Never changes what is stored - it only reads it.
export function parseScriptureRef(raw) {
  if (!raw) return { reference: '', quote: null };
  const s = String(raw).trim().replace(/^Day\s*\d+\s*[:\-–—]\s*/i, '');
  const q = s.match(/[—–-]\s*["“‘'](.+?)["”’']?\s*$/s);
  const m = s.match(/^((?:[1-3]\s?)?[A-Za-z][A-Za-z.\s]*?\s*\d+(?:\s*:\s*\d+(?:\s*[-–]\s*\d+(?:\s*:\s*\d+)?)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*)?)/);
  const reference = (m ? m[1] : s.split(/\s[—–-]\s/)[0]).replace(/\s+/g, ' ').trim();
  return { reference, quote: q ? q[1].trim() : null };
}

// Passage lookups are remembered for the browser session so paging through days stays fast and stays
// within the free API's rate limit. Failures are never cached.
function cacheGet(key) {
  try { const v = sessionStorage.getItem('wt-passage:' + key); return v ? JSON.parse(v) : null; } catch { return null; }
}
function cacheSet(key, value) {
  try { sessionStorage.setItem('wt-passage:' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export async function getPassage(rawRef) {
  const { reference } = parseScriptureRef(rawRef);
  if (!reference) return null;
  const cached = cacheGet(reference);
  if (cached) return cached;
  try {
    const res = await fetch(`https://bible-api.com/${encodeURIComponent(reference)}?translation=web`);
    if (!res.ok) return null;
    const data = await res.json();
    const result = {
      reference: data.reference,
      text: data.text.trim(),
      // verse-by-verse, so longer readings can show verse numbers
      verses: Array.isArray(data.verses) ? data.verses.map(v => ({ n: v.verse, t: String(v.text || '').trim() })) : [],
    };
    cacheSet(reference, result);
    return result;
  } catch {
    return null;
  }
}
