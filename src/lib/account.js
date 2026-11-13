// Helpers for the NEW account features. Every call here degrades gracefully: if the new database
// objects (migration 005) are not present yet, they simply report "nothing special" so the existing
// site keeps working exactly as before.
import { supabase } from './supabase.js';

// Returns { user, role, mustChangePassword, username } for the signed-in user (nulls if unavailable).
export async function getMyAccount() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const user = session.user;
  let role = null, mustChangePassword = false, username = null;
  try {
    const m = await supabase.from('app_members').select('role').eq('user_id', user.id).maybeSingle();
    if (!m.error) role = m.data?.role ?? null;
    const d = await supabase.from('account_details').select('username, must_change_password').eq('user_id', user.id).maybeSingle();
    if (!d.error && d.data) { mustChangePassword = !!d.data.must_change_password; username = d.data.username ?? null; }
  } catch { /* new tables not available yet */ }
  return { user, role, mustChangePassword, username };
}

// Calls the secure account-management function. Returns { data, error } where error is a plain message.
export async function invokeAdmin(body) {
  const { data, error } = await supabase.functions.invoke('wt-admin', { body });
  if (error) {
    let message = 'Something went wrong. Nothing was changed.';
    try { const j = await error.context?.json?.(); if (j?.error) message = j.error; } catch { /* keep generic message */ }
    return { data: null, error: message };
  }
  if (data?.error) return { data: null, error: data.error };
  return { data, error: null };
}

// Verifies the person's own current password without changing the signed-in session.
export async function reauthenticate(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return !error;
}
