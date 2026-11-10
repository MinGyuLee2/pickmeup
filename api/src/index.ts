import pg from 'pg';
import { buildApp, expirePickups } from './app.js';
import { migrate } from './db.js';
import { smsMode, realSmsMode, senderFromEnvironment } from './sms.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Run scripts/db.sh start.');
if (!process.env.APP_SECRET) throw new Error('APP_SECRET is required. See .env.example.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
const mode=smsMode(process.env.SMS_MODE);
if(realSmsMode(mode))senderFromEnvironment(process.env); // Validate credentials without sending anything.
await migrate(pool);
const hops=process.env.TRUST_PROXY_HOPS ?? '0';
if(!['0','1'].includes(hops))throw new Error('TRUST_PROXY_HOPS must be 0 or 1');
const app = buildApp(pool, {
  secret:process.env.APP_SECRET,
  webPushPublicKey:process.env.WEB_PUSH_PUBLIC_KEY,
  kakaoRouteKey:process.env.KAKAO_ROUTE_REST_KEY,
  publicOrigin:process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173',
  smsMode:mode,
  production:process.env.NODE_ENV === 'production',
  proxyHops:Number(hops) as 0 | 1,
});
const expiry = setInterval(() => { void expirePickups(pool).catch(() => console.error('Pickup expiry maintenance failed')); }, 5_000);
expiry.unref();
app.addHook('onClose', async () => { clearInterval(expiry); await pool.end(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
await app.listen({ port: Number(process.env.PORT ?? 4310), host: process.env.HOST ?? '127.0.0.1' });
console.log(`PickMeUp API listening; SMS mode: ${mode==='local' ? 'LOCAL SIMULATION (no text sent)' : mode}`);
