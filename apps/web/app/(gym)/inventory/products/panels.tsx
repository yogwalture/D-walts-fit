'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';

/**
 * The counter, and the two ways stock changes.
 *
 * The till is built around how a sale actually happens: somebody puts two
 * things on the counter, you say the total out loud, they pay. So the
 * running total is always visible, the payment defaults to the full amount,
 * and the result names the invoice rather than saying "done".
 */

interface ProductOption {
  id: string;
  name: string;
  unit: string;
  sellingPrice: string;
  quantityOnHand: string;
  isActive: boolean;
}

interface MemberOption {
  id: string;
  name: string;
  memberCode: string;
  phone: string;
}

const rupees = (value: number) =>
  `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function send(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false as const,
      message: payload?.error?.message ?? 'Something went wrong. Please try again.',
    };
  }
  return { ok: true as const, data: payload?.data ?? {} };
}

export function ProductPanels({
  canSell,
  canManage,
  products,
  members,
  filter,
  search,
}: {
  canSell: boolean;
  canManage: boolean;
  products: ProductOption[];
  members: MemberOption[];
  filter: string;
  search: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [mode, setMode] = useState<'closed' | 'sell' | 'product' | 'stock'>('closed');
  const [term, setTerm] = useState(search);

  useEffect(() => setTerm(search), [search]);

  useEffect(() => {
    if (term === search) return;
    const timer = setTimeout(() => {
      const query = new URLSearchParams();
      if (filter === 'low') query.set('filter', 'low');
      if (term.trim()) query.set('q', term.trim());
      startTransition(() => router.replace(`/inventory/products?${query}`));
    }, 300);
    return () => clearTimeout(timer);
  }, [term, search, filter, router]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          className="input max-w-xs"
          placeholder="Product name or code"
          aria-label="Search products"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
        />

        <div className="flex gap-1.5" role="group" aria-label="Filter products">
          {[
            { value: 'all', label: 'All' },
            { value: 'low', label: 'Running out' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              className={filter === option.value ? 'btn-primary' : 'btn-secondary'}
              onClick={() => {
                const query = new URLSearchParams();
                if (option.value === 'low') query.set('filter', 'low');
                if (term.trim()) query.set('q', term.trim());
                startTransition(() => router.replace(`/inventory/products?${query}`));
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        <span className="flex-1" />

        {canSell && products.length > 0 && (
          <button type="button" className="btn-primary" onClick={() => setMode('sell')}>
            Sell at the counter
          </button>
        )}
        {canSell && products.length > 0 && (
          <button type="button" className="btn-secondary" onClick={() => setMode('stock')}>
            Stock in or correct
          </button>
        )}
        {canManage && (
          <button type="button" className="btn-secondary" onClick={() => setMode('product')}>
            Add a product
          </button>
        )}
      </div>

      {mode === 'sell' && (
        <TillPanel
          products={products.filter((p) => p.isActive)}
          members={members}
          onDone={() => {
            setMode('closed');
            startTransition(() => router.refresh());
          }}
        />
      )}

      {mode === 'stock' && (
        <StockPanel
          products={products}
          onDone={() => {
            setMode('closed');
            startTransition(() => router.refresh());
          }}
        />
      )}

      {mode === 'product' && (
        <NewProductPanel
          onDone={() => {
            setMode('closed');
            startTransition(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}

function TillPanel({
  products,
  members,
  onDone,
}: {
  products: ProductOption[];
  members: MemberOption[];
  onDone: () => void;
}) {
  const [basket, setBasket] = useState<Array<{ product: ProductOption; quantity: number }>>([]);
  const [memberId, setMemberId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [method, setMethod] = useState('CASH');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | {
    invoiceCode: string;
    total: string;
    receiptCode: string | null;
  }>(null);

  const total = useMemo(
    () => basket.reduce((sum, line) => sum + Number(line.product.sellingPrice) * line.quantity, 0),
    [basket],
  );

  function add(product: ProductOption) {
    setMessage(null);
    setBasket((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      const onHand = Number(product.quantityOnHand);
      if (existing) {
        if (existing.quantity + 1 > onHand) {
          setMessage(`Only ${onHand} ${product.unit} of ${product.name} left.`);
          return current;
        }
        return current.map((line) =>
          line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      if (onHand < 1) {
        setMessage(`${product.name} is out of stock.`);
        return current;
      }
      return [...current, { product, quantity: 1 }];
    });
  }

  async function take() {
    setBusy(true);
    setMessage(null);

    const result = await send('/api/v1/inventory/sales', {
      lines: basket.map((line) => ({
        productId: line.product.id,
        quantity: String(line.quantity),
      })),
      memberId: memberId || undefined,
      customerName: customerName.trim() || undefined,
      payment: { amount: total.toFixed(2), method },
    });
    setBusy(false);

    if (!result.ok) {
      setMessage(result.message);
      return;
    }

    setDone({
      invoiceCode: result.data.invoiceCode,
      total: result.data.total,
      receiptCode: result.data.receiptCode,
    });
    setBasket([]);
  }

  if (done) {
    return (
      <section className="card p-5">
        <h2 className="text-base font-semibold text-ink">
          {rupees(Number(done.total))} taken — invoice {done.invoiceCode}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          {done.receiptCode
            ? `Receipt ${done.receiptCode}. It is a proper GST invoice, in the same list as a membership sale.`
            : 'Recorded against the member’s account.'}
        </p>
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn-primary" onClick={() => setDone(null)}>
            Next sale
          </button>
          <button type="button" className="btn-secondary" onClick={onDone}>
            Done
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card p-5">
      {message && (
        <div
          role="alert"
          className="mb-3 rounded-control border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-ink"
        >
          {message}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-base font-semibold text-ink">On the shelf</h2>
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {products.map((product) => {
              const out = Number(product.quantityOnHand) < 1;
              return (
                <li key={product.id}>
                  <button
                    type="button"
                    disabled={out}
                    onClick={() => add(product)}
                    className="flex w-full items-center justify-between gap-3 rounded-control border border-line px-3 py-2 text-left transition-colors hover:border-accent disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1 truncate text-base text-ink">
                      {product.name}
                    </span>
                    <span className="text-sm text-ink-muted">
                      {out ? 'Out of stock' : `${product.quantityOnHand} left`}
                    </span>
                    <span className="text-base text-ink">
                      {rupees(Number(product.sellingPrice))}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div>
          <h2 className="mb-2 text-base font-semibold text-ink">This sale</h2>

          {basket.length === 0 ? (
            <p className="text-sm text-ink-muted">Nothing on the counter yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {basket.map((line) => (
                <li key={line.product.id} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-base text-ink">
                    {line.product.name}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={Number(line.product.quantityOnHand)}
                    value={line.quantity}
                    aria-label={`Quantity of ${line.product.name}`}
                    className="input w-20"
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setBasket((current) =>
                        current.map((entry) =>
                          entry.product.id === line.product.id
                            ? { ...entry, quantity: Math.max(1, next) }
                            : entry,
                        ),
                      );
                    }}
                  />
                  <span className="w-24 text-right text-base text-ink">
                    {rupees(Number(line.product.sellingPrice) * line.quantity)}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary"
                    aria-label={`Remove ${line.product.name}`}
                    onClick={() =>
                      setBasket((current) =>
                        current.filter((entry) => entry.product.id !== line.product.id),
                      )
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-3 text-xl font-semibold text-ink" data-testid="till-total">
            {rupees(total)}
          </p>
          <p className="text-sm text-ink-subtle">GST is included in the marked price.</p>

          <div className="mt-4 space-y-3">
            <div>
              <label htmlFor="sale-member" className="mb-1 block text-sm font-medium text-ink">
                Member
              </label>
              <select
                id="sale-member"
                className="input"
                value={memberId}
                onChange={(event) => setMemberId(event.target.value)}
              >
                <option value="">Not a member</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name} · {member.memberCode}
                  </option>
                ))}
              </select>
            </div>

            {!memberId && (
              <div>
                <label htmlFor="sale-customer" className="mb-1 block text-sm font-medium text-ink">
                  Name for the invoice
                </label>
                <input
                  id="sale-customer"
                  className="input"
                  placeholder="Optional"
                  value={customerName}
                  onChange={(event) => setCustomerName(event.target.value)}
                />
              </div>
            )}

            <div>
              <label htmlFor="sale-method" className="mb-1 block text-sm font-medium text-ink">
                Paid by
              </label>
              <select
                id="sale-method"
                className="input"
                value={method}
                onChange={(event) => setMethod(event.target.value)}
              >
                {['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE'].map((value) => (
                  <option key={value} value={value}>
                    {value.replace('_', ' ').toLowerCase()}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={busy || basket.length === 0}
                onClick={take}
              >
                {busy ? 'Taking…' : `Take ${rupees(total)}`}
              </button>
              <button type="button" className="btn-secondary" onClick={onDone}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function StockPanel({
  products,
  onDone,
}: {
  products: ProductOption[];
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [movementType, setMovementType] = useState('PURCHASE');

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const raw = String(form.get('quantity') ?? '').trim();

    // Stock out is written as a negative number, so the form does the sign
    // rather than asking the person at the desk to remember it.
    const magnitude = Math.abs(Number(raw));
    const signed =
      movementType === 'WASTAGE'
        ? `-${magnitude}`
        : movementType === 'ADJUSTMENT'
          ? raw
          : String(magnitude);

    setBusy(true);
    const result = await send('/api/v1/inventory/stock', {
      productId: String(form.get('productId') ?? ''),
      movementType,
      quantity: signed,
      unitPrice: String(form.get('unitPrice') ?? '').trim() || undefined,
      notes: String(form.get('notes') ?? '').trim() || undefined,
    });
    setBusy(false);

    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-5" noValidate>
      {message && (
        <div
          role="alert"
          className="rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {message}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="productId" className="mb-1 block text-sm font-medium text-ink">
            Product
          </label>
          <select id="productId" name="productId" className="input" required>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name} — {product.quantityOnHand} {product.unit}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="movementType" className="mb-1 block text-sm font-medium text-ink">
            What happened
          </label>
          <select
            id="movementType"
            className="input"
            value={movementType}
            onChange={(event) => setMovementType(event.target.value)}
          >
            <option value="PURCHASE">Stock arrived</option>
            <option value="WASTAGE">Damaged or expired</option>
            <option value="ADJUSTMENT">Correction after a count</option>
            <option value="RETURN">Returned by a customer</option>
          </select>
        </div>

        <div>
          <label htmlFor="quantity" className="mb-1 block text-sm font-medium text-ink">
            How many
          </label>
          <input
            id="quantity"
            name="quantity"
            type="number"
            step="0.001"
            className="input"
            required
            autoFocus
          />
          {movementType === 'ADJUSTMENT' && (
            <p className="mt-1 text-sm text-ink-subtle">
              The difference, not the new total: −2 if two are missing, +3 if three turned up.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="unitPrice" className="mb-1 block text-sm font-medium text-ink">
            Cost each
          </label>
          <input id="unitPrice" name="unitPrice" className="input" placeholder="Optional" />
        </div>
      </div>

      <div>
        <label htmlFor="notes" className="mb-1 block text-sm font-medium text-ink">
          Note
        </label>
        <input
          id="notes"
          name="notes"
          className="input"
          placeholder={
            movementType === 'WASTAGE' ? 'Required — say what happened' : 'Optional'
          }
          required={movementType === 'WASTAGE'}
        />
      </div>

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Recording…' : 'Record'}
        </button>
        <button type="button" className="btn-secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function NewProductPanel({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string): string | undefined => {
      const value = form.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed.length > 0 ? trimmed : undefined;
    };

    setBusy(true);
    const result = await send('/api/v1/inventory/products', {
      name: text('name'),
      category: text('category'),
      sku: text('sku'),
      unit: text('unit') ?? 'piece',
      purchasePrice: text('purchasePrice'),
      sellingPrice: text('sellingPrice'),
      reorderLevel: text('reorderLevel'),
      openingStock: text('openingStock'),
    });
    setBusy(false);

    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-5" noValidate>
      {message && (
        <div
          role="alert"
          className="rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {message}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Labelled id="name" label="Name" required autoFocus />
        <Labelled id="category" label="Category" placeholder="Supplements" />
        <Labelled id="sku" label="Code" placeholder="Optional" />
        <Labelled id="sellingPrice" label="Selling price" required placeholder="2400" />
        <Labelled id="purchasePrice" label="Cost price" placeholder="1800" />
        <Labelled id="unit" label="Sold in" placeholder="piece" />
        <Labelled id="openingStock" label="Stock on hand" placeholder="0" />
        <Labelled id="reorderLevel" label="Reorder at" placeholder="0" />
      </div>

      <p className="text-sm text-ink-subtle">
        The gym’s default GST rate applies unless you set another one, and the selling price is
        taken to include it.
      </p>

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add product'}
        </button>
        <button type="button" className="btn-secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Labelled({
  id,
  label,
  placeholder,
  required,
  autoFocus,
}: {
  id: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        name={id}
        className="input"
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
      />
    </div>
  );
}
