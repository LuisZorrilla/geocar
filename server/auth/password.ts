import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(plain, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Synchronous variant, only for building the demo seed. */
export function hashPasswordSync(plain: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(plain, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Returns an error message in Spanish, or null when the password is acceptable. */
export function validatePasswordPolicy(plain: string | undefined): string | null {
  if (!plain || plain.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
  if (!/[A-Za-z]/.test(plain) || !/\d/.test(plain)) return 'La contraseña debe incluir letras y números.';
  return null;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
