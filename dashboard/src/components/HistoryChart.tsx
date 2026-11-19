import { useState } from "react";

export interface Series {
  label: string;
  color: string;
  values: (number | null)[];
}

interface Props {
  title: string;
  unit: string;
  x: number[]; // simulated day of each sample
  series: Series[];
  height?: number;
  format?: (v: number) => string;
}

// Small dependency-free SVG line chart with a hover crosshair.
export default function HistoryChart({ title, unit, x, series, height = 120, format = (v) => v.toFixed(1) }: Props) {
  const [hi, setHi] = useState<number | null>(null);
  const W = 360, H = height, pl = 40, pr = 8, pt = 8, pb = 18;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  if (x.length < 2 || all.length === 0) {
    return (
      <div className="chart">
        <div className="chart-head"><span>{title}</span><span className="dim">{unit}</span></div>
        <div className="chart-empty">Collecting history — one sample per simulated day</div>
      </div>
    );
  }
  let lo = Math.min(...all), hiV = Math.max(...all);
  if (lo === hiV) { lo -= 1; hiV += 1; }
  const pad = (hiV - lo) * 0.08;
  lo -= pad; hiV += pad;
  const x0 = x[0], x1 = x[x.length - 1];
  const sx = (d: number) => pl + ((d - x0) / Math.max(1, x1 - x0)) * (W - pl - pr);
  const sy = (v: number) => pt + (1 - (v - lo) / (hiV - lo)) * (H - pt - pb);
  const path = (vals: (number | null)[]) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${sx(x[i]).toFixed(1)},${sy(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const ticks = [lo + pad, (lo + hiV) / 2, hiV - pad];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const day = x0 + ((px - pl) / (W - pl - pr)) * (x1 - x0);
    let best = 0;
    for (let i = 1; i < x.length; i++) if (Math.abs(x[i] - day) < Math.abs(x[best] - day)) best = i;
    setHi(best);
  };

  return (
    <div className="chart">
      <div className="chart-head">
        <span>{title}</span>
        <span className="chart-keys">
          {series.map((s) => (
            <span key={s.label}><i style={{ background: s.color }} />{s.label}
              {hi !== null && s.values[hi] !== null && <b className="mono"> {format(s.values[hi] as number)}</b>}
            </span>
          ))}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHi(null)} preserveAspectRatio="none">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pl} x2={W - pr} y1={sy(t)} y2={sy(t)} className="grid" />
            <text x={pl - 4} y={sy(t) + 3} className="axis" textAnchor="end">{format(t)}</text>
          </g>
        ))}
        <text x={pl} y={H - 4} className="axis">day {x0}</text>
        <text x={W - pr} y={H - 4} className="axis" textAnchor="end">day {x1}</text>
        {series.map((s) => <path key={s.label} d={path(s.values)} stroke={s.color} fill="none" strokeWidth={1.6} />)}
        {hi !== null && <line x1={sx(x[hi])} x2={sx(x[hi])} y1={pt} y2={H - pb} className="cross" />}
        {hi !== null && <text x={W - pr} y={pt + 9} className="axis" textAnchor="end">day {x[hi]}</text>}
      </svg>
    </div>
  );
}
