#!/usr/bin/env node
// Creates a private migration snapshot. Does not change or stop the source DB.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { providerNames } from '../deploy/runtime-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '.local/aws-deploy');
const secrets = resolve(out, 'secrets');
await mkdir(secrets, { recursive: true, mode: 0o700 });
await chmod(out, 0o700);
await chmod(secrets, 0o700);
const sourceFiles = ['.env', '.local/solapi.env', '.local/public-demo.env', '.local/web-push.env', '.local/kakao-route.env'];
const env = {};
const fingerprints = {};
for (const file of sourceFiles) {
  let value;
  try { value = await readFile(resolve(root, file), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' && file.includes('web-push')) continue; throw error; }
  fingerprints[file] = createHash('sha256').update(value).digest('hex');
  Object.assign(env, parseEnv(value));
}
const web = parseEnv(await readFile(resolve(root, 'web/.env.local'), 'utf8'));
for (const name of ['APP_SECRET', 'DATABASE_URL', 'SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_FROM']) {
  if (!env[name]) throw new Error(`Missing existing setting: ${name}`);
}
if (!web.VITE_KAKAO_MAP_KEY) throw new Error('Existing Kakao JavaScript key is required');
const database = new URL(env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(database.hostname)) throw new Error('Expected the existing local source database');
// Refuse to replace an export with different credentials.
async function sameOrCreate(path, value, mode) {
  try { await writeFile(path, value, { flag: 'wx', mode }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== value) throw new Error('Existing export differs; review it before replacing anything');
  }
  await chmod(path, mode);
}
await sameOrCreate(resolve(secrets, 'app_secret'), env.APP_SECRET + '\n', 0o444);
await sameOrCreate(resolve(secrets, 'db_password'), decodeURIComponent(database.password) + '\n', 0o444);
const providers = providerNames.filter(name => env[name]).map(name => `${name}=${JSON.stringify(env[name])}`).join('\n') + '\n';
const providerRoundTrip = parseEnv(providers);
if (providerNames.some(name => env[name] && providerRoundTrip[name] !== env[name])) throw new Error('Provider settings cannot be represented losslessly');
await sameOrCreate(resolve(secrets, 'providers.env'), providers, 0o444);
const common = `PUBLIC_HOST=pickmeup.calkok.uk\nVITE_KAKAO_MAP_KEY=${web.VITE_KAKAO_MAP_KEY}\n`;
await sameOrCreate(resolve(out, 'deploy.env'), common + 'SECRETS_DIR=/srv/pickmeup-secrets\n', 0o600);
await sameOrCreate(resolve(out, 'validate.env'), common + `SECRETS_DIR=${secrets}\n`, 0o600);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const archive = resolve(out, `database-${stamp}.dump`);
const pgBin = process.env.PICKMEUP_PG_BIN ?? '/opt/homebrew/opt/postgresql@14/bin';
async function pgRun(binary, args) {
  await new Promise((accept, reject) => {
    const child = spawn(resolve(pgBin, binary), args, {
      env: { ...process.env, PGHOST: database.hostname, PGPORT: database.port || '5432', PGUSER: decodeURIComponent(database.username), PGPASSWORD: decodeURIComponent(database.password), PGDATABASE: database.pathname.slice(1) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    // Never echo connection strings or provider payloads from subprocess errors.
    child.stderr.resume();
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`${binary} failed (exit ${code})`)));
  });
}
await writeFile(archive, '', { flag: 'wx', mode: 0o600 });
const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 2000 });
const tables = [];
await client.connect();
try {
  await client.query("SET TIME ZONE 'UTC'");
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  const names = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for (const { tablename } of names) {
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const result = await client.query(`SELECT count(*)::int AS rows, md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text COLLATE "C"),'')) AS digest FROM public.${quoted} t`);
    tables.push({ table: tablename, ...result.rows[0] });
  }
  await pgRun('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--schema=public', '--snapshot', snapshot, '--file', archive]);
  await client.query('COMMIT');
} finally { await client.end(); }
await pgRun('pg_restore', ['--list', archive]);
const dumpHash = createHash('sha256').update(await readFile(archive)).digest('hex');
for (const [file, hash] of Object.entries(fingerprints)) {
  if (createHash('sha256').update(await readFile(resolve(root, file))).digest('hex') !== hash) throw new Error('Source settings changed during snapshot; review before deploying');
}
const manifest = JSON.stringify({ createdAt: new Date().toISOString(), archive, dumpHash, tables, sourceConfigHashes: fingerprints, workers: 'disabled', note: 'Online preparation snapshot; take a final snapshot after pausing old writers before cutover.' }, null, 2) + '\n';
await writeFile(archive.replace(/\.dump$/, '.manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
await writeFile(resolve(out, 'snapshot.json'), manifest, { mode: 0o600 });
console.log('Private credentials exported unchanged; PostgreSQL public schema snapshot created and archive index verified.');
console.log(`Snapshot: ${archive}`);
console.log('No messages sent. Source DB and service processes remain running.');
