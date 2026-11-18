import type { Metadata } from 'next';
import { listProducts, listMovements, shopSummary, listMembers } from '@gym/core';
import { requireActor, holds, planLock } from '@/lib/current-session';
import { FeatureLocked } from '@/components/plan-gate';
import { Badge, Card, EmptyState, PageHeader, StatTile, rupees } from '@/components/ui';
import { ProductPanels } from './panels';

export const metadata: Metadata = { title: 'Shop' };
export const dynamic = 'force-dynamic';

/**
 * The shop behind the front desk.
 *
 * Led by what is running out, because that is the only thing on this screen
 * that needs a decision today. The rest — stock value, what sold — is the
 * owner's question, and the counter itself is one button away.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, actor, ctx } = await requireActor('/inventory/products');

  const locked = planLock(session, 'inventory.product.read');
  if (locked) {
    return (
      <FeatureLocked
        feature={locked}
        title="The shop"
        blurb="Sell supplements and kit at the counter on a proper GST invoice, with stock that keeps its own ledger."
      />
    );
  }

  const params = await searchParams;
  const one = (key: string): string | undefined =>
    typeof params[key] === 'string' ? (params[key] as string) : undefined;

  const search = one('q');
  const lowOnly = one('filter') === 'low';

  const canSell = holds(session, 'inventory.stock.manage');
  const canManage = holds(session, 'inventory.product.manage');

  const [products, summary, movements, members] = await Promise.all([
    listProducts(ctx, actor.permissions, { search, lowOnly, includeInactive: canManage }),
    shopSummary(ctx, actor.permissions),
    listMovements(ctx, actor.permissions, { limit: 12 }),
    canSell && holds(session, 'members.member.read')
      ? listMembers(ctx, actor.permissions, { page: 1, pageSize: 100, filter: 'active' })
      : Promise.resolve({ rows: [], total: 0 }),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader title="Shop" subtitle={`${summary.productCount} products on sale`} />

      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile
          label="Running out"
          value={summary.lowStockCount}
          tone={summary.lowStockCount > 0 ? 'warn' : 'good'}
          hint="At or below reorder level"
        />
        <StatTile label="Stock value" value={rupees(summary.stockValue)} hint="At cost" />
        <StatTile label="Sold today" value={rupees(summary.soldToday)} hint="Over the counter" />
        <StatTile label="Items today" value={summary.itemsSoldToday} hint="Units sold" />
      </div>

      <ProductPanels
        canSell={canSell}
        canManage={canManage}
        products={products.map((product) => ({
          id: product.id,
          name: product.name,
          unit: product.unit,
          sellingPrice: product.sellingPrice,
          quantityOnHand: product.quantityOnHand,
          isActive: product.isActive,
        }))}
        members={members.rows.map((row) => ({
          id: row.id,
          name: row.name,
          memberCode: row.memberCode,
          phone: row.phone,
        }))}
        filter={lowOnly ? 'low' : 'all'}
        search={search ?? ''}
      />

      <Card padded={false}>
        {products.length === 0 ? (
          <EmptyState
            title={lowOnly ? 'Nothing is running out' : 'Nothing on the shelf yet'}
            description={
              lowOnly
                ? 'Every product is above its reorder level.'
                : 'Add what the gym sells — supplements, drinks, kit — and the counter can start selling it.'
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {products.map((product) => (
              <li key={product.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium text-ink">
                    {product.name}
                    {!product.isActive && (
                      <span className="ml-2 text-sm font-normal text-ink-subtle">retired</span>
                    )}
                  </p>
                  <p className="truncate text-sm text-ink-muted">
                    {[product.category, product.sku, `${product.taxPercentage ?? '0'}% GST`]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>

                <span className="text-base text-ink">{rupees(product.sellingPrice)}</span>

                <span className="w-28 text-right text-sm text-ink-muted">
                  {product.quantityOnHand} {product.unit}
                </span>

                {product.needsReorder && <Badge tone="expiring">Reorder</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {movements.length > 0 && (
        <Card
          title="Stock movements"
          description="Every change, with the balance it left behind"
          padded={false}
        >
          <ul className="divide-y divide-line">
            {movements.map((movement) => (
              <li key={movement.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base text-ink">{movement.productName}</p>
                  <p className="truncate text-sm text-ink-muted">
                    {movement.movementType.toLowerCase()}
                    {movement.notes ? ` — ${movement.notes}` : ''}
                    {movement.recordedBy ? ` · ${movement.recordedBy}` : ''}
                  </p>
                </div>
                <span
                  className={`text-base font-medium ${
                    Number(movement.quantity) < 0 ? 'text-danger' : 'text-accent'
                  }`}
                >
                  {Number(movement.quantity) > 0 ? '+' : ''}
                  {movement.quantity}
                </span>
                <span className="w-24 text-right text-sm text-ink-muted">
                  left {movement.balanceAfter}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
