import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HistoryPoint } from "@pulse/shared";
import { clockLabel, shortDate, responseMs } from "@/lib/format";
import { EmptyState } from "@/components/States";

interface ResponseChartProps {
  points: HistoryPoint[];
  /** Use a date axis (7d/30d) instead of an intraday clock axis (24h). */
  daily?: boolean;
}

interface Row {
  t: string;
  ms: number | null;
}

/** Area chart of response time over a window. */
export function ResponseChart({ points, daily = false }: ResponseChartProps) {
  const rows = useMemo<Row[]>(() => points.map((p) => ({ t: p.t, ms: p.ms })), [points]);

  if (rows.length === 0) {
    return <EmptyState title="No response-time data yet" className="py-10" />;
  }

  const fmtAxis = daily ? shortDate : clockLabel;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={rows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
        <defs>
          <linearGradient id="respFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.28} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={fmtAxis}
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          minTickGap={32}
        />
        <YAxis
          width={48}
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v}ms`}
        />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            fontSize: 12,
            color: "hsl(var(--popover-foreground))",
          }}
          labelFormatter={(label) => (daily ? shortDate(String(label)) : clockLabel(String(label)))}
          formatter={(value) => [responseMs(typeof value === "number" ? value : null), "Response"]}
        />
        <Area
          type="monotone"
          dataKey="ms"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          fill="url(#respFill)"
          connectNulls
          dot={false}
          activeDot={{ r: 3 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
