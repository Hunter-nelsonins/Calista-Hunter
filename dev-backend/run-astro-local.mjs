// LOCAL-ONLY: runs the Astro dev server pointed at the FAKE backend (never the real Supabase project).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, PUBLIC_SUPABASE_URL: 'http://localhost:54321', PUBLIC_SUPABASE_ANON_KEY: 'local-anon-key' };
const child = spawn('npx', ['astro', 'dev', '--port', '4321', '--host', '127.0.0.1'], { env, cwd: site, stdio: 'inherit', shell: true });
child.on('exit', code => process.exit(code ?? 0));
