import { useMemo, useState } from "react";
import type { WorldEvent } from "../api";
import { DISASTERS, kindIcon } from "./Panels";

// The whole recorded life of the world on one axis: seasons as bands, events as marks.
export default function WorldTimeline({ events, tick, tpd, dpy, onLocate }: {
  events: WorldEvent[]; tick: number; tpd: number; dpy: number; onLocate: (x: number, y: number) => void;
}) {
  const [hover, setHover] = useState<WorldEvent | null>(null);
  const span = Math.max(tick, tpd * 30);
  const marks = useMemo(() => events.filter((e) => DISASTERS.includes(e.kind) || e.kind === "genesis" || e.kind === "fire_ignition"), [events]);
  const seasons = useMemo(() => {
    const out: { x0: number; x1: number; s: number }[] = [];
    const sLen = (dpy / 4) * tpd;
    for (let t = 0, i = 0; t < span; t += sLen, i++) out.push({ x0: t / span, x1: Math.min(1, (t + sLen) / span), s: i % 4 });
    return out.length > 400 ? [] : out;
  }, [span, tpd, dpy]);
  const years = span / (tpd * dpy);
  const yearStep = years > 2000 ? 1000 : years > 200 ? 100 : years > 20 ? 10 : years > 2 ? 1 : 0.25;
  const ticks: number[] = [];
  for (let y = 0; y <= years; y += yearStep) ticks.push(y);
  const fmt = (t: number) => { const d = Math.floor(t / tpd); return `Year ${Math.floor(d / dpy) + 1}, day ${(d % dpy) + 1}`; };
  return (
    <div className="wtl">
      <div className="wtl-track">
        {seasons.map((s, i) => <span key={i} className={`season s${s.s}`} style={{ left: `${s.x0 * 100}%`, width: `${(s.x1 - s.x0) * 100}%` }} />)}
        {marks.map((e, i) => (
          <button key={i} className={`mark k-${e.kind}`} style={{ left: `${(e.tick / span) * 100}%` }}
            onMouseEnter={() => setHover(e)} onMouseLeave={() => setHover(null)}
            onClick={() => e.x !== null && e.y !== null && onLocate(e.x, e.y)}>
            {e.kind === "fire_ignition" ? "" : kindIcon[e.kind]}
          </button>
        ))}
        <span className="now" style={{ left: `${(tick / span) * 100}%` }} />
      </div>
      <div className="wtl-axis mono">
        {ticks.map((y) => <span key={y} style={{ left: `${(y * tpd * dpy / span) * 100}%` }}>{y === 0 ? "genesis" : `${y} y`}</span>)}
      </div>
      <div className="wtl-read">
        {hover ? <><span className="gold">{fmt(hover.tick)}</span> — {hover.message}</> :
          <span className="dim">{marks.length} recorded events · hover a mark to read it, click to fly there</span>}
      </div>
    </div>
  );
}
