import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeEnvironment } from './runtime-env.mjs';

test('runtime mounts preserve existing secrets and URL-encode database passwords', async () => {
  const files = { app: 'existing-app-secret\n', db: 'a/b@c:#%\n', provider: 'SOLAPI_API_KEY="existing-key"\nSOLAPI_API_SECRET="existing-secret"\nWEB_PUSH_SUBJECT="mailto:owner@example.com"' };
  const env = await runtimeEnvironment({ APP_SECRET_FILE: 'app', DB_PASSWORD_FILE: 'db', PROVIDER_ENV_FILE: 'provider' }, async path => files[path]);
  const url = new URL(env.DATABASE_URL);
  assert.equal(decodeURIComponent(url.password), 'a/b@c:#%');
  assert.equal(url.hostname, 'db');
  assert.equal(env.APP_SECRET, 'existing-app-secret');
  assert.equal(env.SOLAPI_API_SECRET, 'existing-secret');
  assert.equal(env.WEB_PUSH_SUBJECT, 'mailto:owner@example.com');
});

test('legacy SENS file mounts remain supported', async () => {
  const env = await runtimeEnvironment({ DATABASE_URL: 'postgresql://already-set', SENS_SECRET_KEY_FILE: 'sens' }, async () => 'legacy-key\n');
  assert.equal(env.DATABASE_URL, 'postgresql://already-set');
  assert.equal(env.SENS_SECRET_KEY, 'legacy-key');
});

test('provider file cannot override application identity or process settings', async () => {
  for (const name of ['APP_SECRET', 'DATABASE_URL', 'NODE_OPTIONS']) {
    await assert.rejects(runtimeEnvironment({ PROVIDER_ENV_FILE: 'provider' }, async () => `${name}=override`), /Unsupported provider setting/);
  }
});

test('empty mounted secrets fail closed', async () => {
  await assert.rejects(runtimeEnvironment({ APP_SECRET_FILE: 'app' }, async () => '\n'), /Empty secret file/);
  await assert.rejects(runtimeEnvironment({ PROVIDER_ENV_FILE: 'p' }, async () => 'SOLAPI_API_SECRET='), /Empty provider setting/);
});
