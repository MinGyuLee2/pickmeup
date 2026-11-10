#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, '.local/release-signing');
process.umask(0o077);
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed`);
}
function privatePath(path, isDirectory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    throw new Error('Signing material must be owner-only regular files in an owner-only directory');
  }
}
function load() {
  privatePath(directory, true);
  privatePath(join(directory, 'credentials.json'));
  const data = JSON.parse(readFileSync(join(directory, 'credentials.json'), 'utf8'));
  if (data.version !== 1 || data.keystore !== 'pickmeup-release.p12' || data.alias !== 'pickmeup' ||
      typeof data.password !== 'string' || data.password.length < 32) throw new Error('Invalid signing configuration');
  privatePath(join(directory, data.keystore));
  return { ...process.env, PICKMEUP_KEYSTORE: join(directory, data.keystore),
    PICKMEUP_STORE_PASSWORD: data.password, PICKMEUP_KEY_PASSWORD: data.password, PICKMEUP_KEY_ALIAS: data.alias };
}
try {
  const [mode, endpoint, ...extra] = process.argv.slice(2);
  if (extra.length || !['init', 'verify', 'build'].includes(mode) || (mode === 'build' ? !endpoint : endpoint)) {
    throw new Error('Usage: scripts/with-env.sh node scripts/release-signing.mjs init|verify|build [https://PUBLIC_HOST/api]');
  }
  if (mode === 'init' && !existsSync(directory)) {
    mkdirSync(join(root, '.local'), { recursive: true, mode: 0o700 });
    const temporary = mkdtempSync(join(root, '.local/release-signing-'));
    const password = randomBytes(36).toString('base64url');
    // Passwords stay in the child environment; neither argv nor output includes them.
    const env = { ...process.env, PICKMEUP_NEW_KEY_PASSWORD: password };
    run('keytool', ['-genkeypair', '-storetype', 'PKCS12', '-keystore', join(temporary, 'pickmeup-release.p12'),
      '-alias', 'pickmeup', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
      '-dname', 'CN=PickMeUp, O=PickMeUp, C=KR', '-storepass:env', 'PICKMEUP_NEW_KEY_PASSWORD',
      '-keypass:env', 'PICKMEUP_NEW_KEY_PASSWORD'], env);
    writeFileSync(join(temporary, 'credentials.json'), JSON.stringify({ version: 1,
      keystore: 'pickmeup-release.p12', alias: 'pickmeup', password }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    // Existing material is never replaced. A failed generation remains private for manual inspection.
    if (existsSync(directory)) throw new Error('Signing directory appeared during generation; refusing replacement');
    renameSync(temporary, directory);
  }
  const env = load();
  run('keytool', ['-list', '-keystore', env.PICKMEUP_KEYSTORE, '-alias', env.PICKMEUP_KEY_ALIAS,
    '-storepass:env', 'PICKMEUP_STORE_PASSWORD'], env);
  if (mode === 'build') run(join(root, 'scripts/android-release.sh'), [endpoint], env);
  else console.log('Local signing material verified. Keep an encrypted backup outside the source bundle.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
