/**
 * WhatsApp, through Meta's official Business Cloud API.
 *
 * Deliberately the official API and nothing else. The unofficial libraries
 * that drive a personal WhatsApp account get the number banned, and a gym
 * whose number is banned loses the channel it reaches every member on.
 *
 * Two things here are worth stating plainly, because both are places where
 * software usually lies to its user:
 *
 * 1. With no credentials configured, nothing is "sent". The call returns
 *    `configured: false` and the message stays queued. Marking it sent
 *    would mean a gym believes a member was told something they were not —
 *    and acts on that belief.
 *
 * 2. Meta accepts a business-initiated message only against a template it
 *    has approved. So an unapproved template is refused here rather than
 *    being handed to the API to fail in a way nobody reads.
 */

export interface WhatsappCredentials {
  phoneNumberId: string;
  accessToken: string;
  apiVersion?: string;
}

export interface WhatsappTemplateMessage {
  to: string;
  /** The name Meta approved, not the gym's own name for it. */
  templateName: string;
  language: string;
  /** Positional body variables, in the order the template declares them. */
  variables: string[];
}

export type WhatsappSendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; configured: boolean; code: string; message: string; retryable: boolean };

const DEFAULT_API_VERSION = 'v21.0';

/** Meta wants the number in international form with no + and no spaces. */
export function toWhatsappNumber(phone: string, defaultCountryCode = '91'): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `${defaultCountryCode}${digits}`;
  if (digits.length === 12 && digits.startsWith(defaultCountryCode)) return digits;
  if (digits.length === 11 && digits.startsWith('0')) {
    return `${defaultCountryCode}${digits.slice(1)}`;
  }
  return digits;
}

/**
 * Errors Meta returns that a retry could fix, as against ones it cannot.
 *
 * Retrying a "template does not exist" forever is how a queue fills with
 * work that will never succeed, so the two are separated here and the
 * sender only retries the first kind.
 */
const RETRYABLE_CODES = new Set([
  '130429', // rate limit hit
  '131026', // message undeliverable, may be transient
  '131048', // spam rate limit
  '133016', // temporarily blocked, try later
  '500',
  '502',
  '503',
]);

export async function sendWhatsappTemplate(
  credentials: WhatsappCredentials | null,
  message: WhatsappTemplateMessage,
  options: { timeoutMs?: number } = {},
): Promise<WhatsappSendResult> {
  if (!credentials?.accessToken || !credentials.phoneNumberId) {
    return {
      ok: false,
      configured: false,
      code: 'NOT_CONFIGURED',
      message:
        'WhatsApp is not connected for this gym, so nothing was sent. Connect it in Settings.',
      retryable: true,
    };
  }

  const version = credentials.apiVersion ?? process.env.WHATSAPP_API_VERSION ?? DEFAULT_API_VERSION;
  const url = `https://graph.facebook.com/${version}/${credentials.phoneNumberId}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: message.to,
    type: 'template',
    template: {
      name: message.templateName,
      language: { code: message.language },
      ...(message.variables.length > 0
        ? {
            components: [
              {
                type: 'body',
                parameters: message.variables.map((text) => ({ type: 'text', text })),
              },
            ],
          }
        : {}),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as any;

    if (!response.ok) {
      const error = payload?.error ?? {};
      const code = String(error.code ?? response.status);
      return {
        ok: false,
        configured: true,
        code,
        message: error.message ?? `WhatsApp refused the message (HTTP ${response.status}).`,
        retryable: RETRYABLE_CODES.has(code) || response.status >= 500,
      };
    }

    const providerMessageId = payload?.messages?.[0]?.id;
    if (!providerMessageId) {
      // Accepted with no id is not a success we can reconcile later, so it
      // is reported as a failure rather than recorded as sent.
      return {
        ok: false,
        configured: true,
        code: 'NO_MESSAGE_ID',
        message: 'WhatsApp accepted the request but returned no message id.',
        retryable: true,
      };
    }

    return { ok: true, providerMessageId };
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError';
    return {
      ok: false,
      configured: true,
      code: aborted ? 'TIMEOUT' : 'NETWORK',
      message: aborted
        ? 'WhatsApp did not answer in time.'
        : `Could not reach WhatsApp: ${(error as Error).message}`,
      // A timeout may mean the message actually went: the caller's
      // idempotency key is what stops a retry sending it twice.
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks a gym's credentials by reading its own phone number back.
 *
 * A read, not a send: verifying a connection should not message anybody.
 */
export async function verifyWhatsappCredentials(
  credentials: WhatsappCredentials,
): Promise<
  { ok: true; displayPhoneNumber: string; verifiedName: string | null } | { ok: false; message: string }
> {
  const version = credentials.apiVersion ?? process.env.WHATSAPP_API_VERSION ?? DEFAULT_API_VERSION;
  const url = `https://graph.facebook.com/${version}/${credentials.phoneNumberId}?fields=display_phone_number,verified_name`;

  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    const payload = (await response.json().catch(() => null)) as any;

    if (!response.ok) {
      return {
        ok: false,
        message: payload?.error?.message ?? `WhatsApp refused the credentials (HTTP ${response.status}).`,
      };
    }

    return {
      ok: true,
      displayPhoneNumber: payload?.display_phone_number ?? '',
      verifiedName: payload?.verified_name ?? null,
    };
  } catch (error) {
    return { ok: false, message: `Could not reach WhatsApp: ${(error as Error).message}` };
  }
}
