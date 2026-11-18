'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Changing plan.
 *
 * The consequences are fetched and shown before anything happens: what it
 * costs, what is lost, and — if the gym is too big for the plan — the
 * number that makes it impossible. A gym with 412 members moved onto a
 * 200-member plan must not find out when the 201st cannot be registered.
 */
interface PlanOption {
  key: string;
  name: string;
  tagline: string | null;
  monthlyPrice: number;
}

interface Assessment {
  allowed: boolean;
  direction: string;
  blockers: string[];
  losesFeatures: string[];
  priceDifference: string;
}

export function PlanPanel({
  currentPlanKey,
  plans,
}: {
  currentPlanKey: string;
  plans: PlanOption[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [chosen, setChosen] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function consider(planKey: string) {
    setChosen(planKey);
    setAssessment(null);
    setMessage(null);

    const response = await fetch(`/api/v1/org/billing?planKey=${planKey}`, { method: 'PUT' });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      setMessage(payload?.error?.message ?? 'Could not work out what that would do.');
      return;
    }
    setAssessment(payload?.data ?? null);
  }

  async function confirm() {
    if (!chosen) return;

    setBusy(true);
    const response = await fetch('/api/v1/org/billing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planKey: chosen }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setMessage(payload?.error?.message ?? 'That change was refused.');
      return;
    }

    setChosen(null);
    setAssessment(null);
    startTransition(() => router.refresh());
  }

  return (
    <section className="card p-5">
      <h2 className="text-base font-semibold text-ink">Plans</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Changing plan takes effect straight away. Nothing is charged now — the difference is
        settled on your next invoice.
      </p>

      {message && (
        <div
          role="alert"
          className="mt-3 rounded-control border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-ink"
        >
          {message}
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {plans.map((plan) => {
          const current = plan.key === currentPlanKey;
          return (
            <li
              key={plan.key}
              className={`rounded-control border px-3 py-2.5 ${
                current ? 'border-accent bg-accent-soft' : 'border-line'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-base font-medium text-ink">
                    {plan.name}
                    {current && (
                      <span className="ml-2 text-sm font-normal text-ink-muted">current</span>
                    )}
                  </p>
                  {plan.tagline && (
                    <p className="truncate text-sm text-ink-muted">{plan.tagline}</p>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-sm text-ink-muted">
                    ₹{plan.monthlyPrice.toLocaleString('en-IN')}/month
                  </span>
                  {!current && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => consider(plan.key)}
                    >
                      {chosen === plan.key ? 'Checking…' : 'Consider'}
                    </button>
                  )}
                </div>
              </div>

              {chosen === plan.key && assessment && (
                <div className="mt-3 border-t border-line pt-3">
                  {assessment.blockers.length > 0 ? (
                    <>
                      <p className="text-sm font-medium text-ink">This is not possible yet:</p>
                      <ul className="mt-1 space-y-1">
                        {assessment.blockers.map((blocker) => (
                          <li key={blocker} className="text-sm text-ink-muted">
                            {blocker}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-ink">
                        {Number(assessment.priceDifference) > 0
                          ? `₹${Number(assessment.priceDifference).toLocaleString('en-IN')} more a month.`
                          : Number(assessment.priceDifference) < 0
                            ? `₹${Math.abs(Number(assessment.priceDifference)).toLocaleString('en-IN')} less a month.`
                            : 'The same price.'}
                      </p>

                      {assessment.losesFeatures.length > 0 && (
                        <p className="mt-1 text-sm text-ink-muted">
                          You would lose: {assessment.losesFeatures.join(', ')}. Anything already
                          recorded stays — you just could not add more.
                        </p>
                      )}

                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={busy}
                          onClick={confirm}
                        >
                          {busy ? 'Changing…' : `Move to ${plan.name}`}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setChosen(null);
                            setAssessment(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
