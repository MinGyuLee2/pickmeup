import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

// Provider credentials belong in runtime mounts, never in an image or build arg.
export const providerNames = [
  'SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_FROM',
  'SENS_SERVICE_ID', 'SENS_ACCESS_KEY', 'SENS_SECRET_KEY', 'SENS_FROM',
  'KAKAO_ROUTE_REST_KEY', 'WEB_PUSH_PUBLIC_KEY', 'WEB_PUSH_PRIVATE_KEY', 'WEB_PUSH_SUBJECT',
];

export async function runtimeEnvironment(input, read = readFile) {
  const env = { ...input };
  if (env.PROVIDER_ENV_FILE) {
    const values = parseEnv(await read(env.PROVIDER_ENV_FILE, 'utf8'));
    for (const [name, value] of Object.entries(values)) {
      if (!providerNames.includes(name)) throw new Error(`Unsupported provider setting: ${name}`);
      if (!value.trim()) throw new Error(`Empty provider setting: ${name}`);
      env[name] = value;
    }
  }
  for (const name of ['APP_SECRET', 'DB_PASSWORD', ...providerNames]) {
    if (env[`${name}_FILE`]) {
      const value = (await read(env[`${name}_FILE`], 'utf8')).trim();
      if (!value) throw new Error(`Empty secret file: ${name}`);
      env[name] = value;
    }
  }
  if (!env.DATABASE_URL) {
    if (!env.DB_PASSWORD) throw new Error('DB_PASSWORD_FILE is required');
    const url = new URL('postgresql://db:5432/pickmeup');
    url.username = 'pickmeup';
    url.password = encodeURIComponent(env.DB_PASSWORD);
    env.DATABASE_URL = url.href;
  }
  return env;
}
