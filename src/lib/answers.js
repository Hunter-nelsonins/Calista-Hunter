// Private daily answers. The privacy rule is enforced by the database (row-level security): this code
// simply asks for the day's answers and gets back only what the signed-in person is allowed to see
// (their own, plus the other person's once BOTH have submitted).
import { supabase } from './supabase.js';

export const MAX_ANSWER_LENGTH = 20000;

// Returns { available, mine, theirs }. available=false means the new table isn't there yet.
export async function loadDayAnswers(dayId, myId) {
  const { data, error } = await supabase.from('devotional_answers').select('*').eq('day_id', dayId);
  if (error) return { available: false, mine: null, theirs: null };
  return {
    available: true,
    mine: (data || []).find(r => r.user_id === myId) || null,
    theirs: (data || []).find(r => r.user_id !== myId) || null,
  };
}

export async function saveDraft(dayId, myId, text, existing) {
  if (existing) {
    const { data, error } = await supabase.from('devotional_answers')
      .update({ answer_text: text }).eq('id', existing.id).eq('status', 'draft').select('*').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('This answer was already submitted.');
    return data;
  }
  const { data, error } = await supabase.from('devotional_answers')
    .insert({ day_id: dayId, user_id: myId, answer_text: text, status: 'draft' }).select('*').single();
  if (error) throw error;
  return data;
}

export async function submitAnswer(dayId, myId, text, existing) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Please write an answer first.');
  if (existing) {
    const { data, error } = await supabase.from('devotional_answers')
      .update({ answer_text: trimmed, status: 'submitted' }).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('devotional_answers')
    .insert({ day_id: dayId, user_id: myId, answer_text: trimmed, status: 'submitted' }).select('*').single();
  if (error) throw error;
  return data;
}

// Editing after submission. The server keeps the earlier text and marks the answer "edited".
export async function editSubmitted(existing, text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('An answer cannot be empty.');
  const { data, error } = await supabase.from('devotional_answers')
    .update({ answer_text: trimmed }).eq('id', existing.id).select('*').single();
  if (error) throw error;
  return data;
}

// Safety copy on this device so typed words survive a dropped connection or a closed tab.
const key = (myId, dayId) => `wt-answer-draft:${myId}:${dayId}`;
export function readLocalDraft(myId, dayId) {
  try { return JSON.parse(localStorage.getItem(key(myId, dayId)) || 'null'); } catch { return null; }
}
export function writeLocalDraft(myId, dayId, text) {
  try { localStorage.setItem(key(myId, dayId), JSON.stringify({ text, savedAt: Date.now() })); } catch { /* storage unavailable */ }
}
export function clearLocalDraft(myId, dayId) {
  try { localStorage.removeItem(key(myId, dayId)); } catch { /* ignore */ }
}
