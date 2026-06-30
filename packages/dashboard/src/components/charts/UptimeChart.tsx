import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyRollup } from "@blip/shared";
import { shortDate, uptimePct } from "@/lib/format";
import { EmptyState } from "@/components/States";

interface Row {
  d: string;
  uptime: number;
}

/** Daily uptime % bar chart, colored by health threshold. */
export function UptimeChart({ daily }: { daily: DailyRollup[] }) {
  const rows = useMemo<Row[]>(
    () => daily.map((d) => ({ d: d.d, uptime: Math.round(d.uptime * 10000) / 100 })),
    [daily],
  );

  if (rows.length === 0) {
    return <EmptyState title="No uptime history yet" className="py-10" />;
  }

  const colorFor = (pct: number) =>
    pct >= 99.9 ? "hsl(var(--up))" : pct >= 99 ? "hsl(var(--degraded))" : "hsl(var(--down))";

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={rows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="d"
          tickFormatter={shortDate}
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          minTickGap={24}
        />
        <YAxis
          width={44}
          domain={[(dataMin: number) => Math.min(95, Math.floor(dataMin)), 100]}
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            fontSize: 12,
            color: "hsl(var(--popover-foreground))",
          }}
          labelFormatter={(label) => shortDate(String(label))}
          formatter={(value) => [uptimePct((typeof value === "number" ? value : 0) / 100), "Uptime"]}
        />
        <Bar dataKey="uptime" radius={[3, 3, 0, 0]} maxBarSize={28}>
          {rows.map((r) => (
            <Cell key={r.d} fill={colorFor(r.uptime)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
