import { getJobsClient } from '@gym/db';

/**
 * Which plan a gym would need for a feature.
 *
 * Read from the plan table rather than hardcoded, because the tiers are
 * commercial data: when pricing changes, the upgrade prompt changes with it
 * and nobody has to remember to edit a string in the interface.
 */
export interface UpgradeTarget {
  key: string;
  name: string;
  tagline: string | null;
  monthlyPrice: number;
  annualPrice: number;
}

export async function cheapestPlanWithFeature(
  feature: string,
): Promise<UpgradeTarget | null> {
  const db = getJobsClient();

  const plans = await db.platformPlan.findMany({
    // Bounded: more than 50 SaaS plans for one gym is a data
    // problem, and a truncated list beats a request that times out.
    take: 50,
    where: { isPublic: true },
    orderBy: { displayOrder: 'asc' },
    select: {
      key: true,
      name: true,
      tagline: true,
      monthlyPrice: true,
      annualPrice: true,
      features: true,
    },
  });

  const match = plans.find((plan: { features: string[] }) => plan.features.includes(feature));
  if (!match) return null;

  return {
    key: match.key,
    name: match.name,
    tagline: match.tagline,
    monthlyPrice: Number(match.monthlyPrice),
    annualPrice: Number(match.annualPrice),
  };
}

/**
 * The plans a gym may sign up on, cheapest first.
 *
 * Read live rather than hardcoded in the form, so a price or tier change is
 * a data change. ENTERPRISE is excluded from self-serve: it is quoted, and
 * offering it on a signup form would promise a checkout that does not exist.
 */
export async function listSignupPlans(): Promise<
  Array<UpgradeTarget & { tagline: string | null; features: string[]; trialDays: number }>
> {
  const db = getJobsClient();

  const plans = await db.platformPlan.findMany({
    // Bounded: more than 50 SaaS plans for one gym is a data
    // problem, and a truncated list beats a request that times out.
    take: 50,
    where: { isPublic: true, key: { not: 'ENTERPRISE' } },
    orderBy: { displayOrder: 'asc' },
    select: {
      key: true,
      name: true,
      tagline: true,
      monthlyPrice: true,
      annualPrice: true,
      features: true,
      trialDays: true,
    },
  });

  return plans.map((plan: any) => ({
    key: plan.key,
    name: plan.name,
    tagline: plan.tagline,
    monthlyPrice: Number(plan.monthlyPrice),
    annualPrice: Number(plan.annualPrice),
    features: plan.features,
    trialDays: plan.trialDays,
  }));
}
