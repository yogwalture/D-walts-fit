import { payloadTooLarge } from '@gym/core';

/**
 * The most JSON a route will read before refusing.
 *
 * A megabyte is far more than any payload this application sends — the
 * largest is a fortnight of workout plan, which runs to a few hundred
 * kilobytes at its most verbose. The number exists for the request nobody
 * meant to send.
 *
 * A schema cannot do this job. Validation runs over a value that is already
 * in memory, so by the time a `.max()` rejects a million-element array the
 * memory has been spent twice: once decoding the array, and once collecting
 * an issue object per element that failed. The only cheap refusal happens
 * before the read, which is here.
 */
export const MAX_BODY_BYTES = 1_048_576;

/**
 * Reads the JSON body, refusing anything past `limitBytes`.
 *
 * `content-length` is checked first because it costs nothing, but it is a
 * claim rather than a fact — absent on a chunked request, and whatever the
 * sender likes on a hostile one — so the stream is counted as it arrives
 * and cancelled the moment it goes over. A client cannot talk its way past
 * the limit by lying in the header or by omitting it.
 *
 * A body that is not valid JSON yields `{}`, exactly as it did before this
 * function existed: the schema then reports the fields that are missing,
 * which is a more useful answer to the caller than "malformed JSON".
 */
export async function readJsonBody(
  request: Request,
  limitBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limitBytes) throw payloadTooLarge(limitBytes);

  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw payloadTooLarge(limitBytes);
    }
    chunks.push(value);
  }

  if (total === 0) return {};

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return {};
  }
}
