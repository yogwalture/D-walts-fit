import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption for per-tenant integration credentials.
 *
 * AES-256-GCM, which authenticates as well as encrypts: a ciphertext that
 * has been tampered with fails to decrypt rather than yielding plausible
 * rubbish. The key lives only in the environment, so a database dump on its
 * own — the realistic breach — yields nothing usable.
 *
 * The stored form is `v1.<iv>.<tag>.<ciphertext>`, all base64url. The
 * version prefix is there so the key can be rotated later without guessing
 * what any given row was encrypted with.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'ENCRYPTION_KEY is not set, so integration credentials cannot be stored. ' +
        'Generate one with: openssl rand -base64 32',
    );
    this.name = 'EncryptionUnavailableError';
  }
}

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new EncryptionUnavailableError();

  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).');
  }
  return bytes;
}

/** Whether credentials can be stored at all. Checked before asking for any. */
export function encryptionAvailable(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split('.');
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error('That stored credential is not in a format this version can read.');
  }

  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * The last four characters of a secret, for showing which credential is
 * stored without showing the credential. Never the first four: the prefix
 * of a Meta token identifies the app.
 */
export function secretHint(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return tail.length === 4 ? `…${tail}` : '…';
}
