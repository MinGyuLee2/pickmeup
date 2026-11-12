import { runtimeEnvironment } from './runtime-env.mjs';
const target=process.argv[2];
const targets = { api: 'index', worker: 'worker', push: 'push-runner', 'filming-sms':'filming-sms-runner' };
if (!Object.hasOwn(targets, target)) throw new Error('Expected api, worker, push or filming-sms');
Object.assign(process.env, await runtimeEnvironment(process.env));
await import(`./api/dist/${targets[target]}.js`);
