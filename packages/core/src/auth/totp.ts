import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238), implemented on node:crypto rather than pulled in as a
 * dependency. It is forty lines, it is a standard, and an authentication
 * primitive is worth being able to read.
 *
 * A ±1 step window is allowed, which covers ordinary clock drift without
 * widening the guess space meaningfully.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');

  let secret = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return secret;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = '';
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character in TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function codeAt(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function generateTotp(secret: string, at: Date = new Date()): string {
  return codeAt(secret, Math.floor(at.getTime() / 1000 / STEP_SECONDS));
}

export function verifyTotp(secret: string, token: string, at: Date = new Date()): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS);

  for (let drift = -WINDOW; drift <= WINDOW; drift += 1) {
    const expected = Buffer.from(codeAt(secret, counter + drift));
    const supplied = Buffer.from(token);
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
      return true;
    }
  }
  return false;
}

/** The otpauth:// URI an authenticator app scans as a QR code. */
export function totpUri(secret: string, accountEmail: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Single-use recovery codes, shown once when MFA is enabled. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g)!.join('-'),
  );
}
