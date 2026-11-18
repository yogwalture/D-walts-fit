import { cheapestPlanWithFeature, FEATURE_LABEL, formatRupees, toPaise } from '@gym/core';
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
              <p className="text-sm text-ink-muted">
                To move up a plan, the gym owner can write to us from the email on the
                account. Self-serve plan changes are not open yet, so we will not show a
                button that cannot do it.
              </p>
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
