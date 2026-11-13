// Supabase Edge Function entry point for "wt-admin". NOT DEPLOYED (local review only).
//
// Credentials: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase
// into the function runtime automatically. They are never in the browser, the repo, Netlify, or .env.
// This file only wires the platform clients to the narrow `deps` interface that core.js uses.
// Deploy with gateway JWT verification OFF (`--no-verify-jwt`): core.js verifies the token itself by
// asking the Auth server, which works regardless of the project's JWT signing-key type.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createHandler } from './core.js';

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const must = <T>(r: { data: T; error: unknown }): T => {
  if (r.error) throw r.error;
  return r.data;
};

const deps = {
  async verifyToken(jwt: string) {
    const { data, error } = await admin.auth.getUser(jwt); // asks the Auth server; does not just decode
    if (error || !data?.user) return null;
    return { id: data.user.id, email: data.user.email ?? '' };
  },
  async verifyPassword(email: string, password: string) {
    // Throwaway client, nothing persisted: only answers "is this the right password for this account?"
    const c = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await c.auth.signInWithPassword({ email, password });
    return !error;
  },
  async isAdminMember(id: string) {
    const r = await admin.from('app_members').select('role').eq('user_id', id).maybeSingle();
    return must(r)?.role === 'admin';
  },
  async getAuthUser(id: string) {
    const { data, error } = await admin.auth.admin.getUserById(id);
    if (error) throw error;
    const u = data.user;
    return { id: u.id, email: u.email, new_email: u.new_email, email_confirmed_at: u.email_confirmed_at, last_sign_in_at: u.last_sign_in_at };
  },
  async getProfile(id: string) {
    return must(await admin.from('profiles').select('display_name').eq('id', id).maybeSingle());
  },
  async setDisplayName(id: string, name: string) {
    must(await admin.from('profiles').update({ display_name: name }).eq('id', id).select('id'));
  },
  async getAccountDetails(id: string) {
    return must(await admin.from('account_details').select('username, must_change_password').eq('user_id', id).maybeSingle());
  },
  async setAccountDetails(id: string, patch: { username?: string | null; must_change_password?: boolean }) {
    must(await admin.from('account_details').update({ ...patch, updated_at: new Date().toISOString() }).eq('user_id', id).select('user_id'));
  },
  async usernameTaken(username: string, exceptId: string) {
    const rows = must(await admin.from('account_details').select('user_id').ilike('username', username).neq('user_id', exceptId));
    return (rows ?? []).length > 0;
  },
  // Admin API behavior for email: see ADMIN-EDGE-FUNCTION-SECURITY-APPROACH.md ("verified facts") before deploying.
  async changeEmail(id: string, email: string) {
    const { error } = await admin.auth.admin.updateUserById(id, { email });
    if (error) throw error;
  },
  async updateAuthPassword(id: string, password: string) {
    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) throw error;
  },
  async revokeSessions(_id: string) {
    // Intentionally a no-op until the supported session-revocation call is confirmed against current docs.
  },
  async writeAudit(entry: { actor_id: string; action: string; target_user_id: string | null; details: Record<string, unknown> }) {
    must(await admin.from('admin_audit_log').insert(entry));
  },
  async recentReauthFailures(actorId: string, sinceMs: number) {
    const r = await admin.from('admin_audit_log').select('id', { count: 'exact', head: true })
      .eq('actor_id', actorId).eq('action', 'reauth_failed').gte('created_at', new Date(sinceMs).toISOString());
    if (r.error) throw r.error;
    return r.count ?? 0;
  },
};

Deno.serve(createHandler(deps));
