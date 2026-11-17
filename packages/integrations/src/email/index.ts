/**
 * Transactional email, behind a thin interface.
 *
 * The provider is a configuration value, not a code dependency: switching
 * from Resend to Brevo or SES touches this folder and nothing else.
 *
 * With no provider configured — which is the state through most of
 * development — messages are written to the server log instead of being
 * dropped. A reset link that silently goes nowhere is the worst of the three
 * possible behaviours.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface EmailResult {
  delivered: boolean;
  provider: string;
  providerMessageId?: string;
  error?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailResult>;
}

/** Development and test: nothing leaves the machine, nothing is lost. */
class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';

  async send(message: EmailMessage): Promise<EmailResult> {
    console.warn(
      [
        '',
        '─── email (no provider configured) ─────────────────────────',
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        '',
        message.text,
        '────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
    return { delivered: true, provider: this.name, providerMessageId: 'console' };
  }
}

class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          reply_to: message.replyTo,
        }),
        // The hosting plan caps a request at 120 seconds; a hung provider
        // must not take the whole request down with it.
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return {
          delivered: false,
          provider: this.name,
          error: `${response.status} ${await response.text().catch(() => '')}`.slice(0, 300),
        };
      }

      const payload = (await response.json()) as { id?: string };
      return { delivered: true, provider: this.name, providerMessageId: payload.id };
    } catch (error) {
      return {
        delivered: false,
        provider: this.name,
        error: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }
}

let provider: EmailProvider | undefined;

export function getEmailProvider(): EmailProvider {
  if (provider) return provider;

  const apiKey = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM;

  provider =
    process.env.EMAIL_PROVIDER === 'resend' && apiKey && from
      ? new ResendEmailProvider(apiKey, from)
      : new ConsoleEmailProvider();

  return provider;
}

/** Test seam: lets a suite assert what would have been sent. */
export function setEmailProvider(next: EmailProvider | undefined): void {
  provider = next;
}

// ------------------------------------------------------------ templates ---

const appName = () => process.env.NEXT_PUBLIC_APP_NAME ?? 'Gym Cloud';
const appUrl = () => process.env.APP_URL ?? 'http://localhost:3000';

export function passwordResetEmail(input: {
  to: string;
  fullName: string;
  token: string;
}): EmailMessage {
  const link = `${appUrl()}/reset-password?token=${encodeURIComponent(input.token)}`;
  return {
    to: input.to,
    subject: `Reset your ${appName()} password`,
    text: [
      `Hello ${input.fullName},`,
      '',
      'Use the link below to set a new password. It works once and expires in 30 minutes.',
      '',
      link,
      '',
      'If you did not ask for this, you can ignore this email — your password has not changed.',
    ].join('\n'),
  };
}

export function staffInvitationEmail(input: {
  to: string;
  fullName: string;
  gymName: string;
  roleName: string;
  invitedBy: string;
  token: string;
}): EmailMessage {
  const link = `${appUrl()}/accept-invitation?token=${encodeURIComponent(input.token)}`;
  return {
    to: input.to,
    subject: `${input.invitedBy} has invited you to ${input.gymName}`,
    text: [
      `Hello ${input.fullName},`,
      '',
      `${input.invitedBy} has invited you to join ${input.gymName} as ${input.roleName}.`,
      '',
      'Set your own password here — the link expires in 7 days:',
      '',
      link,
      '',
      'Nobody else sets your password, and nobody else can see it.',
    ].join('\n'),
  };
}

export function memberOtpEmail(input: {
  to: string;
  memberName: string;
  code: string;
  gymName: string;
}): EmailMessage {
  return {
    to: input.to,
    subject: `${input.code} is your ${input.gymName} code`,
    text: [
      `Hello ${input.memberName},`,
      '',
      `Your sign-in code is ${input.code}. It expires in 10 minutes.`,
      '',
      'If you did not try to sign in, you can ignore this message.',
    ].join('\n'),
  };
}
