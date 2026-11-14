import { useState } from 'react';
import type { BurndownData } from './burndown';

const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
export function BurndownChart({ data, timezone }: { data: BurndownData; timezone: string }) {
  const [selected, setSelected] = useState<number | null>(null);
  if (!data.start || !data.points.length) return <section className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">No tasks yet. The lifetime burndown will appear when this project has tasks.</section>;
  const points = data.points;
  const last = points[points.length - 1];
  const active = points[Math.min(selected ?? points.length - 1, points.length - 1)];
  const start = Date.parse(data.start); const end = Date.parse(data.end);
  const max = Math.max(1, ...points.map(p => p.total));
  const x = (date: string) => start === end ? 530 : 65 + (Date.parse(date) - start) / (end - start) * 1000;
  const y = (value: number) => 300 - value / max * 250;
  const path = (key: 'total' | 'remaining') => points.map((p, i) => i ? `H${x(p.date)} V${y(p[key])}` : `M${x(p.date)},${y(p[key])}`).join(' ');
  return <section className="space-y-5 rounded-xl border border-border bg-card p-4 md:p-6" aria-label="Lifetime burndown">
    <div className="flex flex-wrap justify-between gap-4"><div><h2 className="text-lg font-semibold">Lifetime task burndown</h2><p className="text-sm text-muted-foreground">{formatDate(data.start)} – {formatDate(data.end)} · {timezone}</p></div>
      <div className="flex gap-6 text-sm"><div><strong className="block text-xl">{last.remaining}</strong>Remaining today</div><div><strong className="block text-xl">{last.total - last.remaining}</strong>Completed</div><div><strong className="block text-xl">{data.taskCount}</strong>Total tasks</div></div></div>
    <div className="flex gap-5 text-xs text-muted-foreground"><span className="flex items-center gap-2"><span className="h-0.5 w-5 bg-sky-500" />Remaining</span><span className="flex items-center gap-2"><span className="w-5 border-t-2 border-dashed border-muted-foreground" />Total scope</span></div>
    <svg role="img" aria-label="Lifetime task burndown" viewBox="0 0 1120 355" className="w-full" style={{ minHeight: 220 }}
      onPointerMove={event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const position = (event.clientX - bounds.left) / bounds.width * 1120;
        let index = 0; for (let i = 0; i < points.length; i++) if (x(points[i].date) <= position) index = i;
        setSelected(index);
      }}>
      <title>Remaining tasks from {data.start} through {data.end}</title>
      {[...new Set([0, Math.round(max / 2), max])].map(value => <g key={value}><line x1="65" x2="1065" y1={y(value)} y2={y(value)} className="stroke-border" /><text x="50" y={y(value) + 4} textAnchor="end" className="fill-muted-foreground text-xs">{value}</text></g>)}
      <text x="10" y="24" className="fill-muted-foreground text-xs">Tasks</text>
      <path d={path('total')} fill="none" className="stroke-muted-foreground" strokeWidth="2" strokeDasharray="6 5" />
      <path d={path('remaining')} fill="none" className="stroke-sky-500" strokeWidth="3" strokeLinejoin="round" />
      <line x1={x(active.date)} x2={x(active.date)} y1="42" y2="300" className="stroke-muted-foreground" strokeDasharray="3 5" />
      <circle cx={x(active.date)} cy={y(active.remaining)} r="5" className="fill-sky-500" />
      <text x="65" y="332" className="fill-muted-foreground text-xs">{formatDate(data.start)}</text>
      {start !== end && <text x="1065" y="332" textAnchor="end" className="fill-muted-foreground text-xs">{formatDate(data.end)}</text>}
    </svg>
    <div className="space-y-2"><p aria-live="polite" className="text-sm">{formatDate(active.date)}: <strong>{active.remaining} remaining</strong> of {active.total} tasks</p>
      <input aria-label="Inspect burndown date" className="w-full accent-sky-500" type="range" min="0" max={points.length - 1} value={selected ?? points.length - 1} onChange={e => setSelected(Number(e.target.value))} />
    </div>
    <p className="text-xs text-muted-foreground">Reconstructed from current tasks’ creation and completion dates, starting at the earliest available task update. Counts are end-of-day ({timezone}); today shows the current count. Deleted tasks and earlier reopenings are not included.</p>
    {(!!data.missingDates || !!data.estimatedCompletions) && <p role="status" className="text-xs text-muted-foreground">{data.missingDates} tasks have missing creation dates; {data.estimatedCompletions} completion dates use last update as an estimate (or today when unavailable).</p>}
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">View chart data</summary><div className="mt-3 max-h-64 overflow-auto"><table className="w-full text-left text-xs"><caption className="mb-2 text-left text-muted-foreground">End-of-day totals on dates with changes, plus the lifetime endpoints.</caption><thead><tr><th className="p-2">Date</th><th>Remaining</th><th>Total scope</th></tr></thead><tbody>{points.map(p => <tr key={p.date} className="border-t border-border"><td className="p-2">{formatDate(p.date)}</td><td>{p.remaining}</td><td>{p.total}</td></tr>)}</tbody></table></div></details>
  </section>;
}
