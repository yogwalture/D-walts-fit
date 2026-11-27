/**
 * The size limit on a JSON request body.
 *
 * GHSA-mrhx-c7xc-m3w5 describes a validator exhausting memory on a large
 * array: an issue object is collected for every element that fails, so the
 * cost of *rejecting* a list grows with the list. The schema is the wrong
 * place to defend against that, because by the time a schema runs, the
 * document has already been decoded into memory. The defence has to come
 * before the read.
 *
 * These tests hold that line. They also hold the three ways a caller might
 * try to talk past it: a `content-length` that lies, a `content-length`
 * that is missing, and a body streamed in small pieces that only adds up to
 * too much at the end.
 */

import { describe, expect, it } from 'vitest';
import { AppError } from '@gym/core';
import { MAX_BODY_BYTES, readJsonBody } from '../../apps/web/lib/json-body';
import { workoutPlanBody } from '../../apps/web/lib/workout-schema';

const jsonRequest = (body: string, headers: Record<string, string> = {}) =>
  new Request('https://example.test/api/v1/thing', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

/** A body of exactly `bytes`, delivered in chunks, with no content-length. */
const streamedRequest = (bytes: number, chunkSize = 64 * 1024) =>
  new Request('https://example.test/api/v1/thing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        let sent = 0;
        while (sent < bytes) {
          const size = Math.min(chunkSize, bytes - sent);
          controller.enqueue(new Uint8Array(size).fill(0x20));
          sent += size;
        }
        controller.close();
      },
    }),
    // Node requires this for a streaming body.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

const tooLarge = async (request: Request, limit?: number) => {
  const error = await readJsonBody(request, limit).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
};

describe('a JSON body is bounded before anything parses it', () => {
  it('reads an ordinary body unchanged', async () => {
    const parsed = await readJsonBody(jsonRequest(JSON.stringify({ name: 'Iron Temple' })));
    expect(parsed).toEqual({ name: 'Iron Temple' });
  });

  it('refuses a body past the limit, as 413 rather than a validation error', async () => {
    const error = await tooLarge(jsonRequest(JSON.stringify({ pad: 'x'.repeat(2048) })), 1024);
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.status).toBe(413);
  });

  it('refuses on content-length alone, without reading the body', async () => {
    const request = jsonRequest('{}', { 'content-length': String(MAX_BODY_BYTES + 1) });
    const error = await tooLarge(request);
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    // Nothing consumed it, so the body is still there to be read.
    expect(request.bodyUsed).toBe(false);
  });

  it('refuses a body whose content-length understates it', async () => {
    const request = jsonRequest(JSON.stringify({ pad: 'x'.repeat(4096) }), {
      'content-length': '10',
    });
    expect((await tooLarge(request, 1024)).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('refuses a streamed body with no content-length at all', async () => {
    const request = streamedRequest(256 * 1024);
    expect(request.headers.get('content-length')).toBeNull();
    expect((await tooLarge(request, 64 * 1024)).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('stops part way through rather than buffering the whole stream', async () => {
    // 4 MB offered in 64 KB pieces against a 128 KB limit: if the limit were
    // only checked at the end, every byte would be in memory first.
    const request = streamedRequest(4 * 1024 * 1024);
    expect((await tooLarge(request, 128 * 1024)).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('allows a body that sits just under the limit', async () => {
    const payload = JSON.stringify({ pad: 'x'.repeat(900) });
    expect(await readJsonBody(jsonRequest(payload), 2048)).toEqual(JSON.parse(payload));
  });

  it('still answers malformed JSON with an empty object, so the schema reports the fields', async () => {
    expect(await readJsonBody(jsonRequest('{"name":'))).toEqual({});
  });

  it('treats an absent body as an empty object', async () => {
    const request = new Request('https://example.test/api/v1/thing', { method: 'POST' });
    expect(await readJsonBody(request)).toEqual({});
  });
});

describe('the workout plan is bounded too', () => {
  const day = (items: number) => ({
    label: 'Push',
    items: Array.from({ length: items }, () => ({
      exerciseId: '00000000-0000-4000-8000-000000000000',
      sets: 3,
    })),
  });

  it('accepts a long but believable day', () => {
    const parsed = workoutPlanBody.safeParse({ name: 'Hypertrophy', days: [day(50)] });
    expect(parsed.success).toBe(true);
  });

  it('refuses a day with more exercises than anyone writes', () => {
    const parsed = workoutPlanBody.safeParse({ name: 'Hypertrophy', days: [day(51)] });
    expect(parsed.success).toBe(false);
  });

  it('bounds the plan as a whole, not only each day', () => {
    const parsed = workoutPlanBody.safeParse({
      name: 'Hypertrophy',
      days: Array.from({ length: 15 }, () => day(1)),
    });
    expect(parsed.success).toBe(false);
  });
});
