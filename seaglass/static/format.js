// Numbers, times and statuses as the frontend shows them.

export function fmt(v) {
  if (v == null || Number.isNaN(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e4) return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v);
  if (Number.isInteger(v)) return v.toLocaleString("en");
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return "0";
  return v.toPrecision(3);
}

// a value as shown, followed by its unit (SPEC.md §3.3) if it has one
export function withUnit(text, unit) {
  if (!unit || text === "–") return text;
  return unit === "%" ? `${text}%` : `${text} ${unit}`;
}

// axis ticks are already round numbers: just drop float noise and trailing zeros
export function fmtTick(v) {
  return Math.abs(v) >= 1e4 ? fmt(v) : String(+v.toPrecision(6));
}

export function ago(t, now = Date.now() / 1000) {
  const s = Math.max(0, now - t);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(s) {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
}

export function started(t) {
  return new Date(t * 1000).toLocaleString("en", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// a running run sends a heartbeat at least every 30s; one silent this long has
// probably died (SPEC.md §3.1)
export const STALE_S = 120;

export function status(run, now = Date.now() / 1000) {
  if (run.status === "running" && now - run.updated > STALE_S) return "stale";
  return run.status;
}

// "41 / 300" when the run said where it ends, else "step 41"
export function progress(run) {
  if (run.step == null) return "";
  return run.total != null && run.step <= run.total ? `${run.step} / ${run.total}` : `step ${run.step}`;
}

// what a running run says it's doing, and for how long: "evaluating · 2m 10s"
export function activity(run, now = Date.now() / 1000) {
  if (run.status !== "running" || !run.activity) return "";
  return `${run.activity} · ${duration(now - run.activity_since)}`;
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1 << 30) return `${(n / (1 << 20)).toFixed(1)} MiB`;
  return `${(n / (1 << 30)).toFixed(1)} GiB`;
}
