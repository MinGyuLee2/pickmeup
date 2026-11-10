import { readFile } from 'node:fs/promises';
// Secrets are mounted at runtime, never passed as image build arguments.
for (const name of ['APP_SECRET','DB_PASSWORD','SENS_SERVICE_ID','SENS_ACCESS_KEY','SENS_SECRET_KEY','SENS_FROM']) {
  const path=process.env[`${name}_FILE`];
  if (path) process.env[name]=(await readFile(path,'utf8')).trim();
}
if (!process.env.DATABASE_URL) {
  if (!process.env.DB_PASSWORD) throw new Error('DB_PASSWORD_FILE is required');
  const url=new URL('postgresql://db:5432/pickmeup');
  url.username='pickmeup';url.password=process.env.DB_PASSWORD;
  process.env.DATABASE_URL=url.href;
}
const target=process.argv[2];
if (!['api','worker'].includes(target)) throw new Error('Expected api or worker');
await import(`./api/dist/${target==='api'?'index':'worker'}.js`);
