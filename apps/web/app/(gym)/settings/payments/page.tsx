import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getGatewaySettings } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { GatewayPanel } from './panel';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Online payments' };

/**
 * Connecting the gym's own Razorpay account.
 *
 * Their account, not ours, and the page says why: the fee a member pays is
 * the gym's money and it should land in the gym's bank the next morning
 * without passing through us. That is also the only arrangement that does
 * not make this software a payment aggregator.
 */
export default async function PaymentSettingsPage() {
  const { session, actor, ctx } = await requireActor('/settings/payments');
  if (!holds(session, 'org.integration.read')) notFound();

  const settings = await getGatewaySettings(ctx, actor.permissions);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Online payments</h1>
        <p className="mt-1 text-base text-ink-muted">
          Take membership fees by UPI, card and netbanking. The money goes to your own
          Razorpay account and settles into your own bank — it never passes through us.
        </p>
      </div>

      {!settings.encryptionAvailable && (
        <div className="rounded-card border border-danger/30 bg-danger/5 px-4 py-3 text-base text-ink">
          This server has no encryption key configured, so payment credentials cannot be
          stored safely. Nothing can be connected until that is set up.
        </div>
      )}

      {settings.isVerified && settings.isLiveMode === false && (
        <div className="rounded-card border border-warning/30 bg-warning/5 px-4 py-3 text-base text-ink">
          These are <strong>test</strong> credentials (<code>rzp_test_…</code>). Payments
          will look like they work and no money will move. Swap in your live keys when you
          are ready to take real payments.
        </div>
      )}

      <GatewayPanel initial={settings} canEdit={holds(session, 'org.integration.update')} />

      <section className="card p-5">
        <h2 className="text-lg font-semibold text-ink">What a member sees</h2>
        <p className="mt-2 text-base text-ink-muted">
          Once this is connected and switched on, an unpaid invoice in the member app gets a
          Pay button. Until then it tells them to pay at the desk, which is true — rather
          than offering a button that opens an error.
        </p>
        <p className="mt-3 text-base text-ink-muted">
          A payment is recorded only after Razorpay confirms it to our server. Nothing a
          member&rsquo;s phone claims is treated as money, so a closed window, a lost
          connection or a declined card cannot mark an invoice paid — and cannot charge
          anyone twice.
        </p>
      </section>
    </div>
  );
}
