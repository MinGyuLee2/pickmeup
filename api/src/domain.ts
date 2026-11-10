import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class Problem extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function same(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function secrets(secret: string) {
  const key = Buffer.from(secret, 'base64');
  if (key.length !== 32) throw new Error('APP_SECRET must be a base64-encoded 32-byte key');
  return {
    digest: (value: string) => createHmac('sha256', key).update(value).digest('hex'),
    seal(value: unknown) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
    },
    open<T>(value: string): T {
      const data = Buffer.from(value, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')) as T;
    },
  };
}
export function text(value: unknown, label: string, max = 80): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Problem(400, 'INVALID_INPUT', `${label}을 확인해 주세요.`);
  }
  return value.trim().normalize('NFC');
}
export function phone(value: unknown) {
  const number = text(value, '전화번호', 20).replace(/[-\s]/g, '');
  if (!/^01[016789]\d{7,8}$/.test(number)) throw new Problem(400, 'INVALID_PHONE', '국내 휴대전화 번호를 입력해 주세요.');
  return number;
}
export function uuid(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)) {
    throw new Problem(400, 'INVALID_ID', '요청 ID를 확인해 주세요.');
  }
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Problem(400, 'INVALID_INPUT', '요청 내용을 확인해 주세요.');
  return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    throw new Problem(400, 'INVALID_OBSERVATION', '좌표·남은 시간·수신 지연을 확인해 주세요.');
  }
  return value;
}
export function point(value: unknown) {
  const input = object(value);
  return { latitude: number(input.latitude, -90, 90), longitude: number(input.longitude, -180, 180) };
}
export function destination(value: unknown) {
  const input = object(value);
  return { ...point(input), name: text(input.name, '픽업 장소', 150) };
}
/** Ages use elapsed time on the device. Server time anchors freshness even when the car clock is wrong. */
export function observation(value: unknown, now: number) {
  const input = object(value);
  const locationAgeMs = number(input.locationAgeMs, 0, 86_400_000, true);
  const etaAgeMs = number(input.etaAgeMs, 0, 86_400_000, true);
  return {
    location: point(input.location),
    remainingSeconds: number(input.remainingSeconds, 0, 604_800, true),
    remainingMeters: number(input.remainingMeters, 0, 20_000_000, true),
    locationReceivedAt: new Date(now - locationAgeMs).toISOString(),
    etaReceivedAt: new Date(now - etaAgeMs).toISOString(),
    uploadedAt: new Date(now).toISOString(),
  };
}
export type Observation = ReturnType<typeof observation>;
export function fresh(sample: Observation | null, now: number) {
  if (!sample) return false;
  return [sample.locationReceivedAt, sample.etaReceivedAt].every(t => {
    const age = now - Date.parse(t); return age >= 0 && age <= 30_000;
  });
}
