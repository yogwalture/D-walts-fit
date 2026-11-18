import Link from 'next/link';
import { cheapestPlanWithFeature, FEATURE_LABEL, formatRupees, toPaise } from '@gym/core';
import { getSession, holds } from '@/lib/current-session';
import { Card } from '@/components/ui';

/**
 * What a gym sees where their plan stops.
 *
 * Not an error page. The feature exists, their role allows it, and the only
 * thing in the way is the tier they are on — so the page says which plan
 * includes it and what it costs, and leaves the decision with them.
 */
export async function FeatureLocked({
  feature,
  title,
  blurb,
}: {
  feature: string;
  title: string;
  blurb: string;
}) {
  const plan = await cheapestPlanWithFeature(feature);
  const label = FEATURE_LABEL[feature] ?? feature;

  // Only offered to somebody who can actually act on it. A receptionist
  // meeting this screen should not be sent to a page that refuses them.
  const session = await getSession();
  const canChange = holds(session, 'org.billing.update');

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card>
        <div className="space-y-4 p-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            Not on your plan
          </p>
          <h1 className="text-2xl font-semibold text-ink">{title}</h1>
          <p className="text-base text-ink-muted">{blurb}</p>

          {plan ? (
            <div className="space-y-3 rounded-card border border-line bg-canvas p-4 text-left">
              <p className="text-base text-ink">
                <span className="font-semibold">{plan.name}</span> includes {label}
                {plan.tagline ? ` — ${plan.tagline.toLowerCase()}` : ''}.
              </p>
              <p className="text-sm text-ink-muted">
                {formatRupees(toPaise(plan.monthlyPrice))} a month, or{' '}
                {formatRupees(toPaise(plan.annualPrice))} a year.
              </p>
              {canChange ? (
                <Link href="/settings/billing" className="btn-primary inline-flex">
                  See plans
                </Link>
              ) : (
                <p className="text-sm text-ink-muted">
                  The gym owner can change the plan from Settings. Nothing you have entered is
                  affected either way.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">
              Ask us about {label} — it is not part of any self-serve plan yet.
            </p>
          )}

          <p className="text-sm text-ink-subtle">
            Nothing you have entered is affected, and no data is lost by staying on your
            current plan.
          </p>
        </div>
      </Card>
    </div>
  );
}
