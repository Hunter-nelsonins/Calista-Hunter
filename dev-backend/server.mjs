// LOCAL-ONLY Supabase look-alike for testing the website with FAKE data. Never deployed, never touches the
// real project. It speaks enough of Supabase's HTTP API (auth, REST, storage, functions) for the real
// @supabase/supabase-js client to work, and the data API runs every request through the real Postgres
// row-level-security rules (in-memory Postgres via PGlite), so privacy behavior is genuinely exercised.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDb, seedExpandedSample, TEST_USERS, STRANGER_ID } from './db.mjs';
import { createHandler } from '../supabase/functions/wt-admin/core.js';

export const ANON_KEY = 'local-anon-key';
const SITE = 'http://localhost:4321';
const BUCKETS = new Set(['avatars', 'devotional-photos']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function startServer({ port = 54321, stranger = false, quiet = false, expandedSample = true, migrate = true, dbOptions = {} } = {}) {
  const db = await createDb({ stranger, migrate, ...dbOptions });
  if (expandedSample && migrate) await seedExpandedSample(db);
  const secret = crypto.randomBytes(32);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-local-storage-'));
  const mimes = new Map();
  const outbox = [];
  const refreshTokens = new Map();

  // ---------- helpers ----------
  const b64u = b => Buffer.from(b).toString('base64url');
  const hmac = s => crypto.createHmac('sha256', secret).update(s).digest('base64url');
  const signJwt = payload => { const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify(payload)); return `${h}.${p}.${hmac(h + '.' + p)}`; };
  const verifyJwt = t => {
    const parts = String(t || '').split('.'); if (parts.length !== 3) return null;
    const e = hmac(parts[0] + '.' + parts[1]); if (e.length !== parts[2].length || !crypto.timingSafeEqual(Buffer.from(e), Buffer.from(parts[2]))) return null;
    try { const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); return p.exp * 1000 > Date.now() ? p : null; } catch { return null; }
  };
  const hashPw = (pw, salt = crypto.randomBytes(16)) => ({ salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 32).toString('hex') });
  const checkPw = (u, pw) => crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(u.salt, 'hex'), 32), Buffer.from(u.hash, 'hex'));

  const users = new Map();
  for (const t of TEST_USERS.filter(u => stranger || u.id !== STRANGER_ID))
    users.set(t.id, { id: t.id, email: t.email, ...hashPw(t.password), created_at: '2026-08-01T00:00:00Z', last_sign_in_at: null, email_confirmed_at: '2026-08-01T00:00:00Z', new_email: null });
  const userObject = u => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.email_confirmed_at, phone: '', confirmed_at: u.email_confirmed_at,
    last_sign_in_at: u.last_sign_in_at, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: u.created_at, updated_at: new Date().toISOString(), ...(u.new_email ? { new_email: u.new_email } : {}) });
  function issueSession(u, extra = {}) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = signJwt({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', exp, iat: exp - 3600, session_id: crypto.randomUUID(), ...extra });
    const refresh = crypto.randomBytes(16).toString('hex'); refreshTokens.set(refresh, u.id);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: refresh, user: userObject(u) };
  }
  const authCtx = req => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
    if (!m) return { role: 'anon', sub: '' };
    const p = verifyJwt(m[1]);
    if (!p || !users.has(p.sub)) return { role: 'anon', sub: '' };
    return { role: 'authenticated', sub: p.sub };
  };

  // one request at a time (single in-memory connection)
  let chain = Promise.resolve();
  const serial = fn => { const run = chain.then(fn, fn); chain = run.then(() => {}, () => {}); return run; };

  // ---------- response helpers ----------
  const CORS = req => ({
    'Access-Control-Allow-Origin': req.headers.origin || '*', 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Type', 'Access-Control-Max-Age': '600',
  });
  const send = (req, res, status, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const payload = isBuf ? body : (body === undefined || body === null ? '' : JSON.stringify(body));
    res.writeHead(status, { ...(isBuf ? {} : (payload ? { 'Content-Type': 'application/json' } : {})), ...CORS(req), ...headers });
    res.end(req.method === 'HEAD' ? undefined : payload);
  };
  const readBody = req => new Promise((resolve, reject) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });

  // ---------- AUTH ----------
  async function handleAuth(req, res, url, raw) {
    const route = url.pathname.replace('/auth/v1', '');
    const body = raw.length ? safeJson(raw) : {};
    const err = (status, code, msg) => send(req, res, status, { code: status, error_code: code, msg, error: code, error_description: msg });
    if (route === '/token' && req.method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const u = [...users.values()].find(x => x.email === String(body.email || '').toLowerCase());
        if (!u || !checkPw(u, String(body.password || ''))) return err(400, 'invalid_credentials', 'Invalid login credentials');
        u.last_sign_in_at = new Date().toISOString();
        return send(req, res, 200, issueSession(u));
      }
      if (grant === 'refresh_token') {
        const id = refreshTokens.get(body.refresh_token);
        if (!id) return err(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        refreshTokens.delete(body.refresh_token);
        return send(req, res, 200, issueSession(users.get(id)));
      }
      return err(400, 'unsupported_grant_type', 'unsupported grant type');
    }
    const ctx = authCtx(req);
    if (route === '/user' && req.method === 'GET') {
      if (ctx.role !== 'authenticated') return err(401, 'bad_jwt', 'invalid JWT');
      return send(req, res, 200, userObject(users.get(ctx.sub)));
    }
    if (route === '/user' && req.method === 'PUT') {
      if (ctx.role !== 'authenticated') return err(401, 'bad_jwt', 'invalid JWT');
      const u = users.get(ctx.sub);
      if (body.password !== undefined) {
        if (String(body.password).length < 8) return err(422, 'weak_password', 'Password should be at least 8 characters.');
        if (checkPw(u, String(body.password))) return err(422, 'same_password', 'New password should be different from the old password.');
        Object.assign(u, hashPw(String(body.password)));
      }
      if (body.email !== undefined && body.email !== u.email) {   // Supabase's standard flow: confirmation required
        u.new_email = String(body.email).toLowerCase();
        outbox.push({ type: 'email_change', to: u.new_email, user_id: u.id, note: 'open /dev/confirm-email?user=<id> to simulate clicking the link' });
      }
      return send(req, res, 200, userObject(u));
    }
    if (route === '/logout' && req.method === 'POST') {
      for (const [t, id] of refreshTokens) if (id === ctx.sub) refreshTokens.delete(t);
      return send(req, res, 204);
    }
    if (route === '/recover' && req.method === 'POST') {
      const u = [...users.values()].find(x => x.email === String(body.email || '').toLowerCase());
      if (u) { const s = issueSession(u); outbox.push({ type: 'recovery', to: u.email, link: `${SITE}/reset-password#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&token_type=bearer&type=recovery` }); }
      return send(req, res, 200, {}); // same answer whether or not the account exists
    }
    return err(404, 'not_found', 'Not found');
  }

  // ---------- REST (PostgREST subset) ----------
  const colCache = new Map();
  const tableCols = async (tx, table) => {
    if (!colCache.has(table)) {
      const r = await tx.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1`, [table]);
      colCache.set(table, new Set(r.rows.map(x => x.column_name)));
    }
    return colCache.get(table);
  };
  const bad = (msg, status = 400, code = 'PGRST100') => Object.assign(new Error(msg), { status, pgrst: code });
  function splitTop(s) { // split on commas outside quotes
    const out = []; let cur = '', q = false;
    for (const ch of s) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out;
  }
  function buildWhere(params, cols, args) {
    const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict']);
    const clauses = [];
    for (const [k, v] of params) {
      if (RESERVED.has(k)) continue;
      if (!IDENT.test(k) || !cols.has(k)) throw bad(`column "${k}" does not exist`, 400, '42703');
      let neg = false, rest = v; if (rest.startsWith('not.')) { neg = true; rest = rest.slice(4); }
      const dot = rest.indexOf('.'); const op = rest.slice(0, dot), val = rest.slice(dot + 1); const col = `"${k}"`;
      const p = x => { args.push(x); return `$${args.length}`; };
      let c;
      switch (op) {
        case 'eq': c = `${col} = ${p(val)}`; break;
        case 'neq': c = `${col} <> ${p(val)}`; break;
        case 'gt': c = `${col} > ${p(val)}`; break;
        case 'gte': c = `${col} >= ${p(val)}`; break;
        case 'lt': c = `${col} < ${p(val)}`; break;
        case 'lte': c = `${col} <= ${p(val)}`; break;
        case 'like': c = `${col}::text like ${p(val.replace(/\*/g, '%'))}`; break;
        case 'ilike': c = `${col}::text ilike ${p(val.replace(/\*/g, '%'))}`; break;
        case 'is': c = val === 'null' ? `${col} is null` : `${col} is ${val === 'true' ? 'true' : val === 'false' ? 'false' : 'unknown'}`; break;
        case 'in': c = `${col}::text = any(${p(splitTop(val.replace(/^\(|\)$/g, '')))}::text[])`; break;
        default: throw bad(`unsupported operator "${op}"`);
      }
      clauses.push(neg ? `not (${c})` : c);
    }
    return clauses.length ? ' where ' + clauses.join(' and ') : '';
  }
  function selectList(sel, cols) {
    if (!sel || sel === '*') return '*';
    const names = sel.split(',').map(s => s.trim());
    for (const n of names) if (!IDENT.test(n) || !cols.has(n)) throw bad(`unsupported select "${n}"`);
    return names.map(n => `"${n}"`).join(',');
  }
  function orderBy(order, cols) {
    if (!order) return '';
    const parts = order.split(',').map(o => { const [c, ...mods] = o.split('.'); if (!cols.has(c)) throw bad(`column "${c}" does not exist`, 400, '42703');
      return `"${c}" ${mods.includes('desc') ? 'desc' : 'asc'}${mods.includes('nullsfirst') ? ' nulls first' : mods.includes('nullslast') ? ' nulls last' : ''}`; });
    return ' order by ' + parts.join(', ');
  }
  const pgStatus = e => ({ '42501': 403, '23505': 409, '23503': 409, '23502': 400, '23514': 400, 'P0001': 400, '42P01': 404, '42703': 400, '22P02': 400 }[e.code] || 400);

  async function handleRest(req, res, url, raw) {
    const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
    if (!IDENT.test(table)) return send(req, res, 404, { message: 'not found' });
    const ctx = authCtx(req);
    const prefer = String(req.headers['prefer'] || '');
    const wantRep = /return=representation/.test(prefer);
    const wantCount = /count=exact/.test(prefer);
    const single = /vnd\.pgrst\.object\+json/.test(String(req.headers['accept'] || ''));
    try {
      const out = await db.transaction(async tx => {
        await tx.query(`select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role',$2,true)`, [ctx.sub, ctx.role]);
        await tx.exec(`set local role ${ctx.role}`);
        const rel = await tx.query(`select 1 from pg_tables where schemaname='public' and tablename=$1`, [table]);
        if (!rel.rows.length) throw bad(`relation "${table}" does not exist`, 404, '42P01');
        const cols = await tableCols(tx, table);
        const args = []; const params = url.searchParams;
        const T = `public."${table}"`;
        if (req.method === 'GET' || req.method === 'HEAD') {
          const where = buildWhere(params, cols, args);
          let sql = `select ${selectList(params.get('select'), cols)} from ${T}${where}${orderBy(params.get('order'), cols)}`;
          if (params.get('limit')) sql += ` limit ${parseInt(params.get('limit'), 10)}`;
          if (params.get('offset')) sql += ` offset ${parseInt(params.get('offset'), 10)}`;
          const rows = (await tx.query(sql, args)).rows;
          let total = null;
          if (wantCount) { const a2 = []; const w2 = buildWhere(params, cols, a2); total = Number((await tx.query(`select count(*)::int n from ${T}${w2}`, a2)).rows[0].n); }
          return { status: 200, rows, total };
        }
        const body = raw.length ? JSON.parse(raw.toString()) : null;
        const returning = wantRep ? ` returning ${selectList(params.get('select'), cols)}` : '';
        if (req.method === 'POST') {
          const rowsIn = Array.isArray(body) ? body : [body];
          const keys = [...new Set(rowsIn.flatMap(r => Object.keys(r)))];
          for (const k of keys) if (!IDENT.test(k) || !cols.has(k)) throw bad(`Could not find the '${k}' column of '${table}' in the schema cache`, 400, 'PGRST204');
          const vals = rowsIn.map(r => `(${keys.map(k => { if (!(k in r)) return 'default'; args.push(r[k] !== null && typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k]); return `$${args.length}`; }).join(',')})`).join(',');
          const onConflict = /resolution=merge-duplicates/.test(prefer) && params.get('on_conflict')
            ? ` on conflict (${params.get('on_conflict').split(',').map(c => `"${c}"`).join(',')}) do update set ${keys.map(k => `"${k}"=excluded."${k}"`).join(',')}` : '';
          const r = await tx.query(`insert into ${T} (${keys.map(k => `"${k}"`).join(',')}) values ${vals}${onConflict}${returning}`, args);
          return { status: 201, rows: wantRep ? r.rows : null };
        }
        if (req.method === 'PATCH') {
          const sets = Object.keys(body);
          for (const k of sets) if (!IDENT.test(k) || !cols.has(k)) throw bad(`Could not find the '${k}' column of '${table}' in the schema cache`, 400, 'PGRST204');
          const setSql = sets.map(k => { args.push(body[k]); return `"${k}" = $${args.length}`; }).join(', ');
          const where = buildWhere(params, cols, args);
          const r = await tx.query(`update ${T} set ${setSql}${where}${returning}`, args);
          return { status: wantRep ? 200 : 204, rows: wantRep ? r.rows : null };
        }
        if (req.method === 'DELETE') {
          const where = buildWhere(params, cols, args);
          const r = await tx.query(`delete from ${T}${where}${returning}`, args);
          return { status: wantRep ? 200 : 204, rows: wantRep ? r.rows : null };
        }
        throw bad('method not allowed', 405);
      });
      const headers = {};
      if (out.total !== null && out.total !== undefined) headers['Content-Range'] = `${out.rows.length ? `0-${out.rows.length - 1}` : '*'}/${out.total}`;
      if (out.rows === null) return send(req, res, out.status, undefined, headers);
      if (single) {
        if (out.rows.length !== 1) return send(req, res, 406, { code: 'PGRST116', details: `The result contains ${out.rows.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' });
        return send(req, res, out.status, out.rows[0], headers);
      }
      return send(req, res, out.status, out.rows, headers);
    } catch (e) {
      const status = e.status || pgStatus(e);
      return send(req, res, status, { code: e.pgrst || e.code || 'PGRST000', details: e.detail || null, hint: null, message: e.message });
    }
  }

  // ---------- STORAGE ----------
  const fileOf = (bucket, name) => path.join(storageRoot, bucket, ...name.split('/'));
  const guessMime = n => ({ svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[n.split('.').pop().toLowerCase()] || 'application/octet-stream');
  function writeFake(bucket, name, svg) { const f = fileOf(bucket, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, svg); mimes.set(`${bucket}/${name}`, 'image/svg+xml'); }
  const fakeSvg = (label, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="${color}"/><text x="400" y="290" font-size="38" text-anchor="middle" fill="#fff" font-family="sans-serif">FAKE TEST PHOTO</text><text x="400" y="340" font-size="26" text-anchor="middle" fill="#fff" font-family="sans-serif">${label} (not a real photo)</text></svg>`;
  writeFake('devotional-photos', 'fake-photo-1.svg', fakeSvg('sample one', '#6B7550'));
  writeFake('devotional-photos', 'fake-photo-2.svg', fakeSvg('sample two', '#3A4358'));

  async function handleStorage(req, res, url, raw) {
    const rest = url.pathname.replace('/storage/v1', '');
    const ctx = authCtx(req);
    const m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(rest);
    if (m && req.method === 'GET') { // serve via signed token
      const [, bucket, name] = m; const t = url.searchParams.get('token') || ''; const [exp, sig] = t.split('.');
      const nm = decodeURIComponent(name);
      if (!exp || Number(exp) < Date.now() / 1000 || sig !== hmac(`${bucket}/${nm}/${exp}`)) return send(req, res, 400, { error: 'invalid token' });
      const f = fileOf(bucket, nm); if (!fs.existsSync(f)) return send(req, res, 404, { error: 'not found' });
      return send(req, res, 200, fs.readFileSync(f), { 'Content-Type': mimes.get(`${bucket}/${nm}`) || guessMime(nm), 'Cache-Control': 'no-store' });
    }
    if (ctx.role !== 'authenticated') return send(req, res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    if (m && req.method === 'POST') {
      const [, bucket, name] = m; const nm = decodeURIComponent(name);
      if (!BUCKETS.has(bucket)) return send(req, res, 404, { error: 'Bucket not found' });
      if (!fs.existsSync(fileOf(bucket, nm))) return send(req, res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const exp = Math.floor(Date.now() / 1000) + (safeJson(raw).expiresIn || 3600);
      return send(req, res, 200, { signedURL: `/object/sign/${bucket}/${name}?token=${exp}.${hmac(`${bucket}/${nm}/${exp}`)}` });
    }
    const up = /^\/object\/([^/]+)\/(.+)$/.exec(rest);
    if (up && req.method === 'POST') {
      const [, bucket, name] = up; const nm = decodeURIComponent(name);
      if (!BUCKETS.has(bucket)) return send(req, res, 404, { error: 'Bucket not found' });
      const f = fileOf(bucket, nm);
      if (fs.existsSync(f) && req.headers['x-upsert'] !== 'true') return send(req, res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      let file = null; for (const [, v] of form.entries()) if (typeof v !== 'string') file = v;
      if (!file) return send(req, res, 400, { error: 'no file' });
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(await file.arrayBuffer()));
      mimes.set(`${bucket}/${nm}`, file.type || guessMime(nm));
      await db.query(`insert into storage.objects(bucket_id,name,owner) select $1,$2,$3 where not exists (select 1 from storage.objects where bucket_id=$1 and name=$2)`, [bucket, nm, ctx.sub]);
      return send(req, res, 200, { Key: `${bucket}/${nm}`, Id: crypto.randomUUID() });
    }
    const rm = /^\/object\/([^/]+)$/.exec(rest);
    if (rm && req.method === 'DELETE') {
      const bucket = rm[1]; const prefixes = safeJson(raw).prefixes || [];
      for (const n of prefixes) { try { fs.unlinkSync(fileOf(bucket, n)); } catch {} await db.query(`delete from storage.objects where bucket_id=$1 and name=$2`, [bucket, n]); }
      return send(req, res, 200, prefixes.map(name => ({ name, bucket_id: bucket })));
    }
    return send(req, res, 404, { error: 'Not found' });
  }

  // ---------- FUNCTIONS ----------
  const q1 = async (sql, args) => (await db.query(sql, args)).rows[0] || null;
  const fnDeps = {
    verifyToken: async jwt => { const p = verifyJwt(jwt); const u = p && users.get(p.sub); return u ? { id: u.id, email: u.email } : null; },
    verifyPassword: async (email, pw) => { const u = [...users.values()].find(x => x.email === email); return !!u && checkPw(u, pw); },
    isAdminMember: async id => (await q1(`select role from public.app_members where user_id=$1`, [id]))?.role === 'admin',
    getAuthUser: async id => { const u = users.get(id); return u && { id: u.id, email: u.email, new_email: u.new_email, email_confirmed_at: u.email_confirmed_at, last_sign_in_at: u.last_sign_in_at }; },
    getProfile: id => q1(`select display_name from public.profiles where id=$1`, [id]),
    setDisplayName: (id, n) => db.query(`update public.profiles set display_name=$2 where id=$1`, [id, n]),
    getAccountDetails: id => q1(`select username, must_change_password from public.account_details where user_id=$1`, [id]),
    setAccountDetails: async (id, patch) => { for (const [k, v] of Object.entries(patch)) { if (!['username', 'must_change_password'].includes(k)) throw new Error('bad column'); await db.query(`update public.account_details set ${k}=$2, updated_at=now() where user_id=$1`, [id, v]); } },
    usernameTaken: async (name, except) => !!(await q1(`select 1 as x from public.account_details where lower(username)=lower($1) and user_id<>$2`, [name, except])),
    changeEmail: async (id, email) => { const u = users.get(id); u.email = email.toLowerCase(); await db.query(`update auth.users set email=$2 where id=$1`, [id, u.email]); },
    updateAuthPassword: async (id, pw) => { Object.assign(users.get(id), hashPw(pw)); },
    revokeSessions: async id => { for (const [t, uid] of refreshTokens) if (uid === id) refreshTokens.delete(t); },
    writeAudit: e => db.query(`insert into public.admin_audit_log(actor_id,action,target_user_id,details) values ($1,$2,$3,$4)`, [e.actor_id, e.action, e.target_user_id, JSON.stringify(e.details || {})]),
    recentReauthFailures: async (actor, sinceMs) => Number((await q1(`select count(*)::int n from public.admin_audit_log where actor_id=$1 and action='reauth_failed' and created_at >= to_timestamp($2)`, [actor, sinceMs / 1000])).n),
  };
  // LOCAL ONLY: log dependency failures (the real function deliberately hides internals from callers).
  for (const [k, fn] of Object.entries(fnDeps)) fnDeps[k] = async (...a) => { try { return await fn(...a); } catch (e) { if (!quiet) console.error('[wt-admin dep failed]', k, e.message); throw e; } };
  const wtAdmin = createHandler(fnDeps);
  async function handleFunction(req, res, url, raw) {
    const name = url.pathname.replace('/functions/v1/', '');
    if (name !== 'wt-admin') return send(req, res, 404, { error: 'function not found' });
    const webReq = new Request('http://local/functions/v1/wt-admin', { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
    const r = await wtAdmin(webReq);
    const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(r.status, headers); res.end(Buffer.from(await r.arrayBuffer()));   // the function sets its own CORS headers, like the real host
  }

  // ---------- server ----------
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (req.method === 'OPTIONS') return send(req, res, 204);
      const raw = await readBody(req);
      await serial(async () => {
        if (url.pathname.startsWith('/auth/v1/')) return handleAuth(req, res, url, raw);
        if (url.pathname.startsWith('/rest/v1/')) return handleRest(req, res, url, raw);
        if (url.pathname.startsWith('/storage/v1/')) return handleStorage(req, res, url, raw);
        if (url.pathname.startsWith('/functions/v1/')) return handleFunction(req, res, url, raw);
        if (url.pathname === '/dev/outbox') return send(req, res, 200, outbox);
        if (url.pathname === '/dev/confirm-email') { const u = users.get(url.searchParams.get('user')); if (u?.new_email) { u.email = u.new_email; u.new_email = null; await db.query(`update auth.users set email=$2 where id=$1`, [u.id, u.email]); } return send(req, res, 200, { ok: true }); }
        if (url.pathname === '/dev/health') return send(req, res, 200, { ok: true, fake: true });
        return send(req, res, 404, { error: 'not found' });
      });
    } catch (e) { try { send(req, res, 500, { message: String(e.message || e) }); } catch {} }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  if (!quiet) console.log(`LOCAL fake Supabase on http://localhost:${port}  (fake data only; Ctrl+C to stop)`);
  return { url: `http://localhost:${port}`, db, users, outbox, server, close: () => new Promise(r => server.close(r)) };
}

function safeJson(raw) { try { return JSON.parse(raw.toString() || '{}'); } catch { return {}; } }

if (import.meta.url === pathToFileURL(process.argv[1]).href) await startServer({ migrate: process.env.WT_NO_MIGRATE !== '1' });
