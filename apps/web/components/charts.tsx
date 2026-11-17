'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * The dashboard's charts.
 *
 * Every series is passed in from the server, already aggregated by SQL —
 * these components only draw. Nothing here fetches, and nothing here invents
 * a data point: an empty month arrives as a zero from `generate_series` and
 * is drawn as a zero.
 */

const ACCENT = '#2563eb';
const PALETTE = ['#2563eb', '#0891b2', '#7c3aed', '#059669', '#d97706', '#db2777', '#64748b'];

export interface SeriesPoint {
  period: string;
  value: number;
}

const compactRupees = (value: number): string => {
  if (value >= 1e7) return `₹${(value / 1e7).toFixed(1)}Cr`;
  if (value >= 1e5) return `₹${(value / 1e5).toFixed(1)}L`;
  if (value >= 1000) return `₹${Math.round(value / 1000)}k`;
  return `₹${value}`;
};

const monthLabel = (period: unknown): string => {
  const date = new Date(`${String(period)}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(period ?? '');
  return new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' }).format(date);
};

/** Recharts hands a formatter `ValueType`, which may be an array or absent. */
const asNumber = (value: unknown): number => {
  const first = Array.isArray(value) ? value[0] : value;
  const parsed = Number(first);
  return Number.isFinite(parsed) ? parsed : 0;
};

function ChartFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

const tooltipStyle = {
  contentStyle: {
    borderRadius: 8,
    border: '1px solid rgb(226 232 240)',
    fontSize: 13,
    padding: '6px 10px',
  },
} as const;

export function RevenueChart({ data }: { data: SeriesPoint[] }) {
  return (
    <ChartFrame>
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity={0.22} />
            <stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="period"
          tickFormatter={monthLabel}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12, fill: 'rgb(100 116 139)' }}
        />
        <YAxis
          tickFormatter={compactRupees}
          tickLine={false}
          axisLine={false}
          width={56}
          tick={{ fontSize: 12, fill: 'rgb(100 116 139)' }}
        />
        <Tooltip
          {...tooltipStyle}
          formatter={(value) => [`₹${asNumber(value).toLocaleString('en-IN')}`, 'Collected']}
          labelFormatter={monthLabel}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={ACCENT}
          strokeWidth={2}
          fill="url(#revenueFill)"
        />
      </AreaChart>
    </ChartFrame>
  );
}

export function CountChart({
  data,
  label,
  color = ACCENT,
}: {
  data: SeriesPoint[];
  label: string;
  color?: string;
}) {
  return (
    <ChartFrame>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <XAxis
          dataKey="period"
          tickFormatter={monthLabel}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12, fill: 'rgb(100 116 139)' }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          allowDecimals={false}
          tick={{ fontSize: 12, fill: 'rgb(100 116 139)' }}
        />
        <Tooltip
          {...tooltipStyle}
          formatter={(value) => [asNumber(value).toLocaleString('en-IN'), label]}
          labelFormatter={monthLabel}
        />
        <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} maxBarSize={44} />
      </BarChart>
    </ChartFrame>
  );
}

export function PeakHoursChart({ data }: { data: Array<{ hour: number; visits: number }> }) {
  const formatted = data.map((point) => ({
    period: `${point.hour}`,
    value: point.visits,
  }));

  const hourLabel = (hour: unknown): string => {
    const value = Number(hour);
    if (value === 0) return '12a';
    if (value === 12) return '12p';
    return value < 12 ? `${value}a` : `${value - 12}p`;
  };

  return (
    <ChartFrame>
      <BarChart data={formatted} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <XAxis
          dataKey="period"
          tickFormatter={hourLabel}
          tickLine={false}
          axisLine={false}
          interval={2}
          tick={{ fontSize: 11, fill: 'rgb(100 116 139)' }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          allowDecimals={false}
          tick={{ fontSize: 12, fill: 'rgb(100 116 139)' }}
        />
        <Tooltip
          {...tooltipStyle}
          formatter={(value) => [asNumber(value).toLocaleString('en-IN'), 'Visits']}
          labelFormatter={(hour) => `${hourLabel(hour)} onwards`}
        />
        <Bar dataKey="value" fill="#0891b2" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ChartFrame>
  );
}

export function MixChart({ data }: { data: Array<{ label: string; value: number }> }) {
  const total = data.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="h-44 w-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius={44}
              outerRadius={70}
              paddingAngle={2}
              strokeWidth={0}
            >
              {data.map((slice, index) => (
                <Cell key={slice.label} fill={PALETTE[index % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip {...tooltipStyle} formatter={(value) => asNumber(value).toLocaleString('en-IN')} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="min-w-0 flex-1 space-y-1.5">
        {data.map((slice, index) => (
          <li key={slice.label} className="flex items-center gap-2 text-base">
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: PALETTE[index % PALETTE.length] }}
            />
            <span className="min-w-0 flex-1 truncate text-ink">{slice.label}</span>
            <span className="tabular-nums text-ink-muted">
              {total > 0 ? `${Math.round((slice.value / total) * 100)}%` : '0%'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
