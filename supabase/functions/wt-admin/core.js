// Walk Together admin/account function: request handling and authorization logic.
// NOT DEPLOYED. Plain JavaScript with no runtime-specific imports, so the exact same code is
// (a) wrapped by index.ts for Supabase Edge Functions (Deno) and (b) unit-tested in Node.
//
// Security model (see ADMIN-EDGE-FUNCTION-SECURITY-APPROACH.md):
//   * The caller's identity comes ONLY from the verified access token (deps.verifyToken asks the
//     Auth server). Nothing in the request body is trusted for "who am I" or "am I admin".
//   * Administrator = Hunter's fixed account ID, AND an allowlist row saying admin. Both must agree.
//   * Only the two approved account IDs can ever be a target. There is no create/delete user path.
//   * Sensitive actions re-verify the caller's own password (stateless), with failure rate-limiting.
//   * The service-role key never appears here: all privileged work goes through the narrow `deps`
//     object, which exposes a fixed set of operations (no generic queries).
//   * Passwords are never logged, stored, or put in audit rows.

export const HUNTER_ID = 'e6db6091-ffd7-49d0-87a6-63d8b516c93a';
export const CALISTA_ID = '31d35809-75f0-4de5-ba5c-5902068d73e6';
export const MANAGED = { [HUNTER_ID]: 'hunter', [CALISTA_ID]: 'calista' };

export const ALLOWED_ORIGINS = [
  'https://calistaandhunter.com',
  'https://www.calistaandhunter.com',
  'https://walktogether.netlify.app',
  'http://localhost:4321',
  'http://127.0.0.1:4321',
];

const MAX_BODY_BYTES = 10_000;
const REAUTH_MAX_FAILURES = 5;
const REAUTH_WINDOW_MS = 15 * 60 * 1000;

export const validate = {
  displayName(v) {
    if (typeof v !== 'string') return 'Display name must be text.';
    const s = v.trim();
    if (s.length < 1 || s.length > 50) return 'Display name must be 1 to 50 characters.';
    if (/[\u0000-\u001f\u007f<>]/.test(s)) return 'Display name contains characters that are not allowed.';
    return null;
  },
  username(v) {
    if (v === null) return null; // clearing a username is allowed
    if (typeof v !== 'string' || !/^[a-z0-9._-]{3,30}$/.test(v)) return 'Username must be 3 to 30 characters: lowercase letters, numbers, dot, dash or underscore.';
    return null;
  },
  email(v) {
    if (typeof v !== 'string' || v.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(v)) return 'That does not look like a valid email address.';
    return null;
  },
  password(v, email) {
    if (typeof v !== 'string' || v.length < 12) return 'Password must be at least 12 characters.';
    if (v.length > 128) return 'Password is too long.';
    if (/^(.)\1+$/.test(v)) return 'Password is too simple.';
    if (email && v.toLowerCase() === String(email).toLowerCase()) return 'Password cannot be the same as the email address.';
    return null;
  },
};

// 20 chars from an alphabet without look-alike characters; uses the platform CSPRNG.
export function generateTemporaryPassword(length = 20) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const out = [];
  const max = Math.floor(256 / alphabet.length) * alphabet.length; // rejection sampling: no modulo bias
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) { if (b < max && out.length < length) out.push(alphabet[b % alphabet.length]); }
  }
  return out.join('');
}

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

export function createHandler(deps, { now = () => Date.now() } = {}) {
  function corsHeaders(origin) {
    const h = {
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Max-Age': '600',
    };
    if (origin && ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
    return h;
  }
  const json = (status, body, origin) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });

  async function requireReauth(caller, password) {
    if (typeof password !== 'string' || !password) throw new HttpError(400, 'Please enter your current password to confirm.');
    const failures = await deps.recentReauthFailures(caller.id, now() - REAUTH_WINDOW_MS);
    if (failures >= REAUTH_MAX_FAILURES) throw new HttpError(429, 'Too many incorrect attempts. Please wait 15 minutes and try again.');
    const ok = await deps.verifyPassword(caller.email, password);
    if (!ok) {
      await deps.writeAudit({ actor_id: caller.id, action: 'reauth_failed', target_user_id: null, details: {} });
      throw new HttpError(403, 'That password was not correct.');
    }
  }

  async function isAdmin(caller) {
    // Both checks must agree: the fixed account ID AND the allowlist role.
    return caller.id === HUNTER_ID && (await deps.isAdminMember(caller.id)) === true;
  }

  function requireManaged(id) {
    if (typeof id !== 'string' || !(id in MANAGED)) throw new HttpError(400, 'That account cannot be managed here.');
    return id;
  }

  async function describeAccount(id) {
    const [u, p, d] = await Promise.all([deps.getAuthUser(id), deps.getProfile(id), deps.getAccountDetails(id)]);
    return {
      id, key: MANAGED[id],
      display_name: p?.display_name ?? null,
      username: d?.username ?? null,
      email: u?.email ?? null,
      pending_email: u?.new_email ?? null,
      email_confirmed: !!u?.email_confirmed_at,
      last_sign_in_at: u?.last_sign_in_at ?? null,
      must_change_password: !!d?.must_change_password,
    };
  }

  async function actionListAccounts(caller) {
    if (!(await isAdmin(caller))) throw new HttpError(403, 'Only the administrator can do that.');
    return { accounts: await Promise.all([HUNTER_ID, CALISTA_ID].map(describeAccount)) };
  }

  async function actionUpdateAccount(caller, body) {
    const target = requireManaged(body.target_id);
    const admin = await isAdmin(caller);
    const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
    const allowedKeys = ['display_name', 'username', 'email'];
    const keys = Object.keys(fields);
    if (!keys.length) throw new HttpError(400, 'Nothing to change.');
    for (const k of keys) if (!allowedKeys.includes(k)) throw new HttpError(400, `Field "${k}" cannot be changed.`);

    if (!admin) {
      // Non-admin (Calista): only her own display name. Her email and password use Supabase's standard secure flows.
      if (target !== caller.id || caller.id === HUNTER_ID) throw new HttpError(403, 'You can only change your own account.');
      if (keys.some(k => k !== 'display_name')) throw new HttpError(403, 'Change your email or password in Account Settings instead.');
    }
    const errors = [];
    if ('display_name' in fields) { const e = validate.displayName(fields.display_name); if (e) errors.push(e); }
    if ('username' in fields) { const e = validate.username(fields.username); if (e) errors.push(e); }
    if ('email' in fields) {
      const e = validate.email(fields.email); if (e) errors.push(e);
      if (!e && body.confirm_email !== fields.email) errors.push('Please type the new email address a second time to confirm it.');
    }
    if (errors.length) throw new HttpError(400, errors[0]);
    if ('username' in fields && fields.username !== null && (await deps.usernameTaken(fields.username, target))) throw new HttpError(409, 'That username is already taken.');

    if ('email' in fields) await requireReauth(caller, body.current_password); // admin email change = sensitive

    const changed = keys.slice();
    if (body.dry_run) return { dry_run: true, would_change: changed, target_id: target };

    if ('display_name' in fields) await deps.setDisplayName(target, fields.display_name.trim());
    if ('username' in fields) await deps.setAccountDetails(target, { username: fields.username });
    if ('email' in fields) await deps.changeEmail(target, fields.email);
    await deps.writeAudit({ actor_id: caller.id, action: 'update_account', target_user_id: target, details: { fields: changed } });
    return { ok: true, changed, account: admin ? await describeAccount(target) : undefined };
  }

  async function actionResetPassword(caller, body) {
    if (!(await isAdmin(caller))) throw new HttpError(403, 'Only the administrator can do that.');
    const target = requireManaged(body.target_id);
    if (target === caller.id) throw new HttpError(400, 'Change your own password in Account Settings.');
    await requireReauth(caller, body.current_password);
    const account = await deps.getAuthUser(target);
    let password = body.new_password;
    let generated = false;
    if (password == null || password === '') { password = generateTemporaryPassword(); generated = true; }
    else { const e = validate.password(password, account?.email); if (e) throw new HttpError(400, e); }
    if (body.dry_run) return { dry_run: true, would: 'reset_password_and_require_change', target_id: target };

    await deps.updateAuthPassword(target, password);
    await deps.setAccountDetails(target, { must_change_password: true });
    if (deps.revokeSessions) { try { await deps.revokeSessions(target); } catch { /* best effort */ } }
    await deps.writeAudit({ actor_id: caller.id, action: 'reset_password', target_user_id: target, details: { generated, must_change_password: true } });
    // The temporary password is returned ONCE, only when we generated it. It is not stored or logged.
    return generated ? { ok: true, temporary_password: password, must_change_password: true } : { ok: true, must_change_password: true };
  }

  async function actionCompletePasswordChange(caller, body) {
    requireManaged(caller.id); // only the two real accounts, always for themselves
    const bad = validate.password(body.new_password, caller.email);
    if (bad) throw new HttpError(400, bad);
    if (body.new_password === body.current_password) throw new HttpError(400, 'Please choose a password different from the temporary one.');
    await requireReauth(caller, body.current_password);
    await deps.updateAuthPassword(caller.id, body.new_password);
    await deps.setAccountDetails(caller.id, { must_change_password: false });
    await deps.writeAudit({ actor_id: caller.id, action: 'password_changed_by_user', target_user_id: caller.id, details: {} });
    return { ok: true };
  }

  return async function handle(req) {
    const origin = req.headers.get('origin');
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
      if (origin && !ALLOWED_ORIGINS.includes(origin)) throw new HttpError(403, 'Origin not allowed.');
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

      const auth = req.headers.get('authorization') || '';
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (!m) throw new HttpError(401, 'Please sign in.');
      const caller = await deps.verifyToken(m[1]);
      if (!caller?.id) throw new HttpError(401, 'Please sign in again.');
      if (!(caller.id in MANAGED)) throw new HttpError(403, 'This account is not allowed to use account management.');

      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.');
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Invalid request.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request.');

      let result;
      switch (body.action) {
        case 'list_accounts': result = await actionListAccounts(caller); break;
        case 'update_account': result = await actionUpdateAccount(caller, body); break;
        case 'reset_password': result = await actionResetPassword(caller, body); break;
        case 'complete_password_change': result = await actionCompletePasswordChange(caller, body); break;
        default: throw new HttpError(400, 'Unknown action.');
      }
      return json(200, result, origin);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message }, origin);
      return json(500, { error: 'Something went wrong. Nothing was changed.' }, origin); // details intentionally not exposed or logged
    }
  };
}
