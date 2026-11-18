import Link from 'next/link';
import { Badge, Card } from '@/components/ui';

interface Row {
  id: string;
  title: string | null;
  className: string;
  colorHex: string | null;
  trainerName: string | null;
  branchName: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number;
  bookedCount: number;
  waitlistCount: number;
  placesLeft: number;
  status: string;
  room: string | null;
}

const time = (value: string) =>
  new Date(value).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

/**
 * The day's classes as a list, led by the time and the places left.
 *
 * Deliberately not a grid of coloured blocks: at the desk the question is
 * "is there room in the 7pm" and a list answers it in one glance, on a phone
 * as well as a screen.
 */
export function ClassList({ rows }: { rows: Row[] }) {
  return (
    <Card padded={false}>
      <ul className="divide-y divide-line">
        {rows.map((row) => {
          const cancelled = row.status === 'CANCELLED';
          const full = row.placesLeft === 0 && !cancelled;

          return (
            <li key={row.id}>
              <Link
                href={`/classes/${row.id}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 transition-colors hover:bg-canvas"
              >
                <div className="w-28 shrink-0">
                  <p className={`text-base font-semibold ${cancelled ? 'text-ink-subtle line-through' : 'text-ink'}`}>
                    {time(row.startsAt)}
                  </p>
                  <p className="text-sm text-ink-subtle">to {time(row.endsAt)}</p>
                </div>

                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-base font-medium text-ink">
                    {row.colorHex && (
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: row.colorHex }}
                      />
                    )}
                    {row.title ?? row.className}
                  </p>
                  <p className="truncate text-sm text-ink-muted">
                    {[row.trainerName ?? 'No trainer yet', row.room, row.branchName]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  {cancelled ? (
                    <Badge tone="expired">Cancelled</Badge>
                  ) : (
                    <>
                      <span className="text-sm text-ink-muted">
                        {row.bookedCount} of {row.capacity}
                      </span>
                      {row.waitlistCount > 0 && (
                        <Badge tone="expiring">{row.waitlistCount} waiting</Badge>
                      )}
                      <Badge tone={full ? 'expired' : 'active'}>
                        {full
                          ? 'Full'
                          : `${row.placesLeft} ${row.placesLeft === 1 ? 'place' : 'places'} left`}
                      </Badge>
                    </>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
