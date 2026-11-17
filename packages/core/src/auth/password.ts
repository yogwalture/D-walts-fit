import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing.
 *
 * Argon2id with OWASP's current recommended parameters. @node-rs/argon2
 * ships prebuilt binaries, so there is no compiler step at install time —
 * which matters on shared hosting, where there is no compiler.
 */
/** 2 = Argon2id. Written as a literal because the library exports it as an
 *  ambient const enum, which isolatedModules cannot read at runtime. */
const ARGON2ID = 2;

const ARGON_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain);
  } catch {
    // A malformed stored hash must fail closed, not throw into the handler.
    return false;
  }
}

/**
 * Compares against a dummy hash so a login attempt for an address that does
 * not exist takes the same time as one that does. Without this, response
 * timing enumerates your user list.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Dw0nBq8VVRcJ1x0tQ0rDXKk9vOqBvh0Kk8z0Z1VhMLo';

export async function fakeVerify(): Promise<void> {
  await verifyPassword(DUMMY_HASH, 'not-the-password');
}

// ------------------------------------------------------------- tokens ---

/**
 * Session, reset and invitation tokens.
 *
 * The raw token goes to the client exactly once; only its SHA-256 is stored,
 * so a database dump yields no usable session. SHA-256 rather than Argon2 is
 * correct here: the input is already 32 bytes of entropy, so there is nothing
 * for a slow hash to defend against, and session lookup happens on every
 * request.
 */
export function generateToken(bytes = 32): { token: string; hash: string } {
  const token = randomBytes(bytes).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Six-digit OTP for member login. Rejects leading-zero loss. */
export function generateOtp(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

// --------------------------------------------------------- policy ------

const COMMON_PASSWORDS = new Set([
  'password1234', 'qwertyuiop12', '123456789012', 'administrator',
  'letmein12345', 'welcome12345', 'iloveyou1234', 'passw0rdpassw0rd',
]);

/**
 * Length over composition rules. A long passphrase beats "P@ssw0rd!" and
 * people actually remember it.
 *
 * In production this also calls the Have I Been Pwned range API, which never
 * sends the password — only the first five characters of its SHA-1. Offline
 * here so a network failure cannot block a password reset.
 */
export function assessPassword(plain: string, context: string[] = []): string[] {
  const problems: string[] = [];
  if (plain.length < 12) problems.push('Use at least 12 characters.');
  if (COMMON_PASSWORDS.has(plain.toLowerCase())) {
    problems.push('That password appears in breach lists. Choose another.');
  }
  for (const value of context) {
    if (value && value.length > 3 && plain.toLowerCase().includes(value.toLowerCase())) {
      problems.push('Your password should not contain your name or email address.');
      break;
    }
  }
  return problems;
}
