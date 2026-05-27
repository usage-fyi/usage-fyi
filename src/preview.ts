import { createServer, type ServerResponse } from "node:http";
import type { Snapshot, Style, DailyEntry } from "./core/index.js";
import { publishSnapshot, PublishError } from "./publish.js";
import { resolvePublishError } from "./errors.js";
import { openBrowser } from "./open.js";

interface ShareResponse {
  id: string;
  url: string;
  manageKey: string;
}

interface ErrorResponse {
  error: string;
}

export interface BuildHtmlOptions {
  apiBase?: string;
  port?: number;
}

function formatLarge(n: number, decimals = 1): string {
  if (n >= 1e9) return (n / 1e9).toFixed(decimals) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(decimals) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(decimals) + "K";
  return Math.round(n).toString();
}

function splitLarge(n: number): { num: string; unit: string } {
  if (n >= 1e9) return { num: (n / 1e9).toFixed(2), unit: "B tokens" };
  if (n >= 1e6) return { num: (n / 1e6).toFixed(1), unit: "M tokens" };
  if (n >= 1e3) return { num: (n / 1e3).toFixed(1), unit: "K tokens" };
  return { num: String(n), unit: "tokens" };
}

function formatCurrency(n: number): string {
  return (
    "$" +
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

const AGENT_COLORS: Record<string, string> = {
  claude: "var(--c-claude)",
  codex: "var(--c-codex)",
  pi: "var(--c-pi)",
};

function agentColor(name: string): string {
  return AGENT_COLORS[name] ?? "var(--muted-2)";
}

function uniqueAgents(daily: DailyEntry[]): string[] {
  const set = new Set<string>();
  for (const d of daily) for (const a of d.a) set.add(a);
  return [...set];
}

function lastNDays(daily: DailyEntry[], n: number): DailyEntry[] {
  return daily.slice(Math.max(0, daily.length - n));
}

function rangeDays(range: [string, string]): number {
  const [from, to] = range;
  const ms = Date.parse(to) - Date.parse(from);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

function buildBars(daily: DailyEntry[]): string {
  if (daily.length === 0) return "";
  const W = 220;
  const H = 90;
  const gap = 2;
  const n = daily.length;
  const bw = (W - gap * (n - 1)) / n;
  const max = Math.max(...daily.map((d) => d.t));
  if (max === 0) return "";
  const peakIdx = daily.findIndex((d) => d.t === max);
  return daily
    .map((d, i) => {
      const bh = Math.max(2, (d.t / max) * (H - 4));
      const x = i * (bw + gap);
      const y = H - bh;
      const hot = i === peakIdx;
      const fill = hot ? "var(--accent)" : "var(--accent-2)";
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.4" fill="${fill}"/>`;
    })
    .join("");
}

export function buildHtml(
  snapshot: Snapshot,
  opts: BuildHtmlOptions = {},
): string {
  const apiBase = opts.apiBase ?? "https://usage.fyi";
  const port = opts.port ?? 4317;
  const localUrl = `http://localhost:${port}/local`;

  const window30 = snapshot.derived.windows.d30;
  const last30 = lastNDays(snapshot.daily, 30);
  const activeDays = last30.length || 1;
  const dailyAvg = window30.t / activeDays;
  const peak = last30.reduce((m, d) => Math.max(m, d.t), 0);
  const totalTokens = splitLarge(window30.t);
  const spendStr = formatCurrency(window30.c);
  const avgStr = formatLarge(dailyAvg, 2);
  const peakStr = formatLarge(peak, 1);
  const bars = buildBars(last30);
  const tool = snapshot.source.tool;
  const days = rangeDays(snapshot.source.range);
  const handleLine = `${tool} · last ${Math.min(days, 30)} days`;
  const agents = uniqueAgents(last30.length ? last30 : snapshot.daily);
  const agentChips = agents.length
    ? agents
        .map(
          (a) =>
            `<span class="agent"><span class="sw" style="background:${agentColor(a)}"></span>${a}</span>`,
        )
        .join("")
    : `<span class="agent"><span class="sw" style="background:var(--c-claude)"></span>claude</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>usage.fyi — local render</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg:        #fafaf9;
    --panel:     #ffffff;
    --panel-2:   #f4f4f2;
    --ink:       #18181b;
    --ink-2:     #3f3f46;
    --muted:     #71717a;
    --muted-2:   #a1a1aa;
    --line:      #e7e7e4;
    --line-2:    #efefec;
    --accent:    oklch(0.72 0.15 65);
    --accent-2:  oklch(0.82 0.12 70);
    --accent-3:  oklch(0.92 0.05 75);
    --accent-ink: oklch(0.32 0.08 50);
    --h-0: #f0efec;
    --h-1: oklch(0.92 0.04 75);
    --h-2: oklch(0.85 0.08 70);
    --h-3: oklch(0.75 0.13 65);
    --h-4: oklch(0.62 0.17 55);
    --h-5: oklch(0.48 0.18 40);
    --m-haiku:   oklch(0.88 0.06 70);
    --m-sonnet:  oklch(0.75 0.12 60);
    --m-opus:    oklch(0.55 0.16 45);
    --c-claude:  oklch(0.72 0.15 65);
    --c-codex:   oklch(0.62 0.10 200);
    --c-pi:      oklch(0.65 0.08 145);
    --font-sans: 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif;
    --font-mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  html, body {
    margin: 0; padding: 0;
    width: 100%;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-sans);
    font-feature-settings: 'ss01', 'cv11', 'tnum';
    -webkit-font-smoothing: antialiased;
  }
  html, body { height: 100%; }
  body { overflow-x: hidden; }
  * { box-sizing: border-box; }

  .page {
    height: 100vh;
    width: 100vw;
    display: grid;
    grid-template-rows: 56px 1fr 44px;
    min-height: 720px;
  }

  /* nav */
  .nav {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 32px;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
  }
  .brand {
    display: flex; align-items: center; gap: 10px;
    font-weight: 600; font-size: 15px; letter-spacing: -0.01em;
    text-decoration: none; color: var(--ink);
  }
  .brand .dot {
    width: 10px; height: 10px; border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 0 4px color-mix(in oklab, var(--accent) 18%, transparent);
  }
  .brand .name { color: var(--ink); }
  .brand .tld  { color: var(--muted); font-weight: 400; }
  .brand .crumb {
    margin-left: 6px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
    font-weight: 400;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .brand .crumb .sl { color: var(--muted-2); }
  .brand .crumb .here { color: var(--ink-2); }

  .nav-links {
    display: flex; gap: 6px; align-items: center;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
  }
  .nav-links a {
    color: var(--muted-2);
    text-decoration: none;
    padding: 6px 10px;
    border-radius: 6px;
  }
  .nav-links a:hover { color: var(--ink); background: var(--panel-2); }
  .nav-links .sep { color: var(--muted-2); padding: 6px 0; }

  /* hero */
  .hero {
    display: grid;
    grid-template-columns: minmax(440px, 1fr) minmax(620px, 1.05fr);
    gap: 0;
    min-height: 0;
  }

  /* LEFT */
  .left {
    padding: 0 56px;
    display: flex; flex-direction: column; justify-content: center;
    max-width: 760px;
    border-right: 1px solid var(--line);
    min-width: 0;
  }
  .eyebrow {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent-ink);
    letter-spacing: 0.02em;
    text-transform: lowercase;
    margin: 0 0 22px;
    display: inline-flex; align-items: center; gap: 8px;
    padding: 5px 10px;
    background: var(--accent-3);
    border-radius: 999px;
    width: max-content;
  }
  .eyebrow::before {
    content: ""; width: 6px; height: 6px; border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 25%, transparent);
    animation: pulse 2.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 25%, transparent); }
    50%      { box-shadow: 0 0 0 6px color-mix(in oklab, var(--accent) 0%, transparent); }
  }

  h1 {
    font-size: 60px;
    line-height: 1.0;
    letter-spacing: -0.028em;
    font-weight: 500;
    margin: 0 0 22px;
    text-wrap: balance;
  }
  h1 em {
    font-style: normal;
    color: var(--accent-ink);
    background: linear-gradient(180deg, transparent 62%, var(--accent-3) 62%);
    padding: 0 4px;
    margin: 0 -2px;
  }
  .sub {
    font-size: 16px;
    line-height: 1.5;
    color: var(--ink-2);
    margin: 0 0 28px;
    max-width: 470px;
  }
  .sub code {
    font-family: var(--font-mono);
    color: var(--ink);
    background: var(--panel-2);
    border: 1px solid var(--line-2);
    padding: 1px 6px;
    border-radius: 5px;
    font-size: 13px;
  }

  .micro {
    margin-top: 4px;
    max-width: 540px;
    display: flex; align-items: center; gap: 16px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
    flex-wrap: wrap;
  }
  .micro span { display: inline-flex; align-items: center; gap: 7px; }
  .micro span::before {
    content: ""; width: 4px; height: 4px; border-radius: 999px;
    background: var(--accent);
  }

  /* RIGHT (local stage) */
  .right {
    position: relative;
    background:
      radial-gradient(80% 60% at 60% 35%, color-mix(in oklab, var(--accent-3) 55%, transparent), transparent 70%),
      var(--panel-2);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
    padding: 28px 32px;
    min-width: 0;
  }
  .right::before {
    content: "";
    position: absolute; inset: 0;
    background-image:
      linear-gradient(var(--line) 1px, transparent 1px),
      linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 32px 32px;
    background-position: -1px -1px;
    opacity: 0.45;
    mask-image: radial-gradient(70% 60% at 50% 50%, #000 40%, transparent 100%);
  }

  .stage {
    position: relative;
    width: min(580px, 100%);
    z-index: 1;
    display: flex; flex-direction: column; gap: 10px;
  }

  /* file:// chip */
  .file-chip {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 7px 14px 7px 10px;
    display: inline-flex; align-items: center; gap: 8px;
    width: max-content;
    box-shadow: 0 1px 0 rgba(24,24,27,0.02);
  }
  .file-chip .ic { width: 14px; height: 14px; color: var(--muted-2); }
  .file-chip .path-text { color: var(--ink-2); }
  .file-chip .path-text b { color: var(--ink); font-weight: 500; }

  /* LOCAL card — HTML mock matching the design */
  .og {
    width: 100%;
    max-width: 580px;
    aspect-ratio: 1200 / 630;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow:
      0 1px 0 rgba(24,24,27,0.03),
      0 30px 60px -30px rgba(24,24,27,0.20),
      0 12px 24px -16px rgba(24,24,27,0.10);
    padding: 26px 28px;
    display: grid;
    grid-template-rows: auto 1fr auto;
    position: relative;
    overflow: hidden;
  }
  .og::after {
    content: "";
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: repeating-linear-gradient(
      45deg,
      var(--accent) 0 6px,
      var(--accent-2) 6px 12px
    );
    opacity: 0.55;
    z-index: 2;
  }
  .og-head {
    display: flex; align-items: center; justify-content: space-between;
  }
  .og-brand {
    display: flex; align-items: center; gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
  }
  .og-brand .dot {
    width: 7px; height: 7px; border-radius: 999px;
    background: var(--accent);
  }
  .og-brand b { color: var(--ink); font-weight: 500; }
  .og-brand .pathfrag { color: var(--muted-2); }
  .og-local {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--ink-2);
    border: 1px dashed var(--muted-2);
    background: var(--panel-2);
    padding: 4px 8px 4px 7px;
    border-radius: 999px;
    display: inline-flex; align-items: center; gap: 6px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .og-local .ic { width: 11px; height: 11px; color: var(--muted); }

  .og-body {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 22px;
    padding: 6px 0;
    min-width: 0;
  }
  .og-handle {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .og-handle b { color: var(--ink); font-weight: 500; }
  .og-hero {
    font-size: 60px;
    font-weight: 500;
    letter-spacing: -0.03em;
    line-height: 1;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .og-hero .unit { font-size: 22px; color: var(--muted); letter-spacing: -0.01em; margin-left: 6px; }
  .og-sub {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
    margin-top: 10px;
    display: flex; gap: 14px;
    flex-wrap: wrap;
  }
  .og-sub b { color: var(--ink); font-weight: 500; }
  .og-bars { height: 88px; width: 210px; }

  .og-foot {
    display: flex; align-items: center; justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
    border-top: 1px solid var(--line-2);
    padding-top: 12px;
    margin-top: 6px;
  }
  .og-foot .agents { display: inline-flex; gap: 10px; align-items: center; }
  .og-foot .agent { display: inline-flex; align-items: center; gap: 6px; }
  .og-foot .agent .sw { width: 8px; height: 8px; border-radius: 2px; }
  .og-foot .right-side { color: var(--muted); }
  .og-foot .right-side b { color: var(--ink-2); font-weight: 500; }

  /* action bar — sits directly under the card */
  .actions {
    display: flex; gap: 10px; align-items: stretch;
    margin-top: 2px;
  }
  .btn-publish {
    flex: 1;
    font: inherit;
    font-family: var(--font-mono);
    font-size: 13px;
    color: #fafafa;
    background: var(--ink);
    border: 1px solid var(--ink);
    padding: 10px 18px;
    border-radius: 9px;
    display: inline-flex; align-items: center; justify-content: center; gap: 10px;
    box-shadow: 0 8px 20px -12px rgba(24,24,27,0.55);
    cursor: pointer;
    transition: background 140ms, transform 140ms;
    letter-spacing: 0.01em;
  }
  .btn-publish:hover { background: #000; }
  .btn-publish:active { transform: translateY(1px); }
  .btn-publish:disabled { cursor: progress; }
  .btn-publish .arrow {
    width: 14px; height: 14px;
    transition: transform 160ms;
  }
  .btn-publish:hover .arrow { transform: translateX(2px); }
  .btn-publish .spinner {
    width: 14px; height: 14px;
    display: none;
    animation: spin 700ms linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .btn-publish.publishing .arrow { display: none; }
  .btn-publish.publishing .spinner { display: inline-block; }
  .btn-publish.done {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    box-shadow: 0 8px 20px -10px color-mix(in oklab, var(--accent) 70%, transparent);
    text-decoration: none;
  }

  /* result row — shows after publishing */
  .result {
    display: none;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    margin-top: 2px;
    flex-direction: column; gap: 10px;
  }
  .result.show { display: flex; }
  .result .lbl {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .result .copy-row {
    display: flex; gap: 8px; align-items: center;
  }
  .result .copy-row code {
    flex: 1;
    background: var(--panel-2);
    border: 1px solid var(--line-2);
    border-radius: 7px;
    padding: 7px 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink);
    overflow-x: auto; white-space: nowrap;
  }
  .result .copy-btn {
    font: inherit;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 7px 10px;
    border-radius: 7px;
    cursor: pointer;
    white-space: nowrap;
  }
  .result .copy-btn:hover { color: var(--ink); border-color: var(--muted-2); }
  .result .warn {
    font-size: 11px;
    color: var(--accent-ink);
    font-family: var(--font-mono);
  }

  .err {
    display: none;
    margin-top: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: #bf3322;
    background: #fbeae8;
    border: 1px solid #f5cfca;
    border-radius: 8px;
    padding: 8px 12px;
  }
  .err.show { display: block; }

  .toast {
    position: fixed; left: 50%; bottom: 26px;
    transform: translateX(-50%) translateY(20px);
    background: var(--ink); color: #fafafa;
    border: 1px solid var(--ink);
    padding: 10px 16px; border-radius: 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    box-shadow: 0 12px 30px -10px rgba(0,0,0,.4);
    opacity: 0; pointer-events: none;
    transition: opacity .2s, transform .2s;
    z-index: 50;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  /* unlock row */
  .unlock-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-top: 6px; margin-bottom: -4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
  }
  .unlock-head .lbl { color: var(--muted-2); text-transform: lowercase; letter-spacing: 0.02em; }
  .unlocks {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 0.8fr;
    gap: 8px;
    margin-top: 4px;
  }
  .unlock-card {
    position: relative;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 12px 10px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(24,24,27,0.02);
    min-height: 84px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .unlock-card .uc-top {
    display: flex; align-items: center; justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--ink-2);
    letter-spacing: 0.01em;
  }
  .unlock-card .uc-top b { color: var(--ink); font-weight: 500; }
  .unlock-card .lock { width: 12px; height: 12px; color: var(--muted-2); }
  .unlock-card .uc-viz {
    flex: 1;
    position: relative;
    filter: saturate(0.4);
    opacity: 0.82;
  }
  .unlock-card::after {
    content: "";
    position: absolute; inset: 0;
    background: linear-gradient(180deg, transparent 30%, color-mix(in oklab, var(--panel) 80%, transparent) 100%);
    pointer-events: none;
  }
  .unlock-card .uc-label {
    position: absolute; left: 0; right: 0; bottom: 10px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--muted);
    z-index: 1;
  }
  .unlock-more {
    position: relative;
    background: var(--panel-2);
    border: 1px dashed var(--muted-2);
    border-radius: 10px;
    padding: 10px 12px;
    text-decoration: none;
    color: var(--ink-2);
    display: flex; flex-direction: column; justify-content: space-between; gap: 6px;
    min-height: 84px;
    overflow: hidden;
    transition: background 160ms, border-color 160ms, color 160ms;
  }
  .unlock-more:hover {
    background: var(--accent-3);
    border-color: var(--accent);
    border-style: solid;
    color: var(--accent-ink);
  }
  .unlock-more .um-dots { display: inline-flex; gap: 3px; }
  .unlock-more .um-dots i {
    width: 4px; height: 4px; border-radius: 999px;
    background: var(--muted-2);
    transition: background 160ms;
  }
  .unlock-more:hover .um-dots i { background: var(--accent); }
  .unlock-more .um-label {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--ink);
    font-weight: 500;
    line-height: 1;
  }
  .unlock-more:hover .um-label { color: var(--accent-ink); }
  .unlock-more .um-sub {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--muted);
    line-height: 1.45;
  }
  .unlock-more .um-arrow {
    position: absolute;
    top: 12px; right: 12px;
    width: 13px; height: 13px;
    color: var(--muted-2);
    transition: color 160ms, transform 160ms;
  }
  .unlock-more:hover .um-arrow { color: var(--accent-ink); transform: translateX(2px); }

  /* mini viz */
  .heatmap-mini {
    display: grid;
    grid-template-columns: repeat(14, 1fr);
    grid-auto-rows: 8px;
    gap: 2px;
  }
  .heatmap-mini i { display: block; border-radius: 1.5px; background: var(--h-1); }

  .stack-mini {
    display: flex; align-items: flex-end; gap: 3px; height: 100%;
    padding-top: 4px;
  }
  .stack-mini .col {
    flex: 1; display: flex; flex-direction: column-reverse;
    gap: 1px; min-height: 12px;
  }
  .stack-mini .col span { display: block; border-radius: 1px; }

  /* foot */
  .foot {
    border-top: 1px solid var(--line);
    background: var(--panel);
    padding: 0 32px;
    display: flex; align-items: center; justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
  }
  .foot-left { display: inline-flex; align-items: center; gap: 12px; }
  .foot-left a {
    color: var(--ink-2);
    text-decoration: none;
    padding: 4px 8px;
    border-radius: 6px;
  }
  .foot-left a:hover { color: var(--ink); background: var(--bg); }
  .foot-right { display: inline-flex; gap: 18px; }
  .foot-right span::before {
    content: "·"; margin-right: 18px; color: var(--muted-2);
  }
  .foot-right span:first-child::before { display: none; }

  @media (max-width: 980px) {
    .page { height: auto; min-height: 100vh; }
    .hero { grid-template-columns: 1fr; }
    .left { border-right: 0; border-bottom: 1px solid var(--line); padding: 40px 32px; }
    .right { padding: 32px; }
    h1 { font-size: 44px; }
  }
</style>
</head>
<body>
<div class="page">

  <nav class="nav">
    <a class="brand" href="${apiBase}" target="_blank" rel="noopener">
      <span class="dot"></span>
      <span class="name">usage</span><span class="tld">.fyi</span>
      <span class="crumb"><span class="sl">/</span><span class="here">cli</span><span class="sl">/</span><span class="here">local</span></span>
    </a>
    <div class="nav-links">
      <a href="${apiBase}/how" target="_blank" rel="noopener">how</a>
      <span class="sep">·</span>
      <a href="${apiBase}/leaderboard" target="_blank" rel="noopener">leaderboard</a>
      <span class="sep">·</span>
      <a href="https://github.com/charlesverdad/usage-fyi" target="_blank" rel="noopener">github</a>
    </div>
  </nav>

  <section class="hero">

    <div class="left">
      <div class="eyebrow">local render · just now</div>

      <h1>Looks good<br/>locally<em>.</em></h1>

      <p class="sub">
        Served by the CLI at <code>localhost:${port}</code>. Publish to mint a permalink
        &amp; unlock the full drilldown.
      </p>

      <div class="micro">
        <span>anonymous by default</span>
        <span>immutable /s/ link</span>
        <span>delete anytime</span>
      </div>
    </div>

    <div class="right">
      <div class="stage">

        <div class="file-chip">
          <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <circle cx="8" cy="8" r="5.6"/>
            <path d="M2.4 8h11.2M8 2.4c2 2 2 9.2 0 11.2M8 2.4c-2 2-2 9.2 0 11.2"/>
          </svg>
          <span class="path-text">${localUrl}</span>
          <span style="color:var(--muted-2); padding-left: 4px; border-left: 1px solid var(--line); margin-left: 6px;">served by cli</span>
        </div>

        <div class="og" id="ogCard">
          <div class="og-head">
            <div class="og-brand">
              <span class="dot"></span><b>usage.fyi</b>
              <span class="pathfrag">· /local · not shared</span>
            </div>
            <span class="og-local">
              <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/>
                <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>
              </svg>
              local · draft
            </span>
          </div>

          <div class="og-body">
            <div>
              <div class="og-handle">${handleLine}</div>
              <div class="og-hero"><span>${totalTokens.num}</span><span class="unit">${totalTokens.unit}</span></div>
              <div class="og-sub">
                <span>spend <b>${spendStr}</b></span>
                <span>daily avg <b>${avgStr}</b></span>
                <span>peak <b>${peakStr}</b></span>
              </div>
            </div>
            <svg class="og-bars" viewBox="0 0 220 90" preserveAspectRatio="none">${bars}</svg>
          </div>

          <div class="og-foot">
            <div class="agents">${agentChips}</div>
            <div class="right-side">rendered <b>just now</b> · offline</div>
          </div>
        </div>

        <div class="actions">
          <button class="btn-publish" id="share" type="button">
            <span class="label">publish</span>
            <svg class="arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M3 8h10M9 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <svg class="spinner" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
              <path d="M8 2a6 6 0 1 1-6 6" opacity="0.9"/>
            </svg>
          </button>
        </div>

        <div class="err" id="err"></div>

        <div class="result" id="result">
          <div>
            <div class="lbl">shareable link</div>
            <div class="copy-row">
              <code id="url"></code>
              <button class="copy-btn" data-copy="url" type="button">copy</button>
            </div>
          </div>
          <div>
            <div class="lbl">manage key</div>
            <div class="copy-row">
              <code id="key"></code>
              <button class="copy-btn" data-copy="key" type="button">copy</button>
            </div>
          </div>
          <div class="warn">save this manage key — it is the only way to delete your link.</div>
          <a class="btn-publish done" id="viewer-link" href="#" target="_blank" rel="noopener" style="display:none">
            <span>open on usage.fyi</span>
            <svg class="arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M3 8h10M9 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </a>
        </div>

        <div class="unlock-head">
          <span class="lbl">publishing unlocks</span>
        </div>
        <div class="unlocks">

          <div class="unlock-card">
            <div class="uc-top">
              <b>calendar heatmap</b>
              <svg class="lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>
              </svg>
            </div>
            <div class="uc-viz">
              <div class="heatmap-mini" id="heatMini"></div>
            </div>
            <div class="uc-label">90 days · click-to-drill</div>
          </div>

          <div class="unlock-card">
            <div class="uc-top">
              <b>model splits</b>
              <svg class="lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>
              </svg>
            </div>
            <div class="uc-viz">
              <div class="stack-mini" id="stackMini"></div>
            </div>
            <div class="uc-label">haiku · sonnet · opus</div>
          </div>

          <div class="unlock-card">
            <div class="uc-top">
              <b>share to socials</b>
              <svg class="lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>
              </svg>
            </div>
            <div class="uc-viz">
              <svg viewBox="0 0 60 36" preserveAspectRatio="xMidYMid meet" style="width:100%; height:100%;">
                <rect x="4" y="6" width="52" height="24" rx="3" fill="var(--panel-2)" stroke="var(--line)"/>
                <circle cx="8" cy="10" r="1.2" fill="var(--accent)"/>
                <rect x="11" y="9" width="16" height="2" rx="0.6" fill="var(--muted-2)"/>
                <rect x="8" y="14" width="20" height="6" rx="0.8" fill="var(--ink-2)"/>
                <g transform="translate(34 16)">
                  <rect x="0" y="5" width="2" height="5" rx="0.4" fill="var(--accent-2)"/>
                  <rect x="3" y="2" width="2" height="8" rx="0.4" fill="var(--accent)"/>
                  <rect x="6" y="4" width="2" height="6" rx="0.4" fill="var(--accent-2)"/>
                  <rect x="9" y="6" width="2" height="4" rx="0.4" fill="var(--accent-2)"/>
                  <rect x="12" y="3" width="2" height="7" rx="0.4" fill="var(--accent-2)"/>
                  <rect x="15" y="5" width="2" height="5" rx="0.4" fill="var(--accent-2)"/>
                  <rect x="18" y="4" width="2" height="6" rx="0.4" fill="var(--accent-2)"/>
                </g>
              </svg>
            </div>
            <div class="uc-label">og card auto-unfurls</div>
          </div>

          <a class="unlock-more" href="${apiBase}/how" target="_blank" rel="noopener">
            <div class="um-dots"><i></i><i></i><i></i></div>
            <div class="um-label">…and more</div>
            <div class="um-sub">cache reuse · hourly heat · cost forecast</div>
            <svg class="um-arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 8h10M9 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </a>

        </div>

      </div>
    </div>
  </section>

  <footer class="foot">
    <div class="foot-left">
      <a href="${apiBase}/how" target="_blank" rel="noopener">how</a>
      <a href="https://github.com/charlesverdad/usage-fyi" target="_blank" rel="noopener">github</a>
    </div>
    <div class="foot-right">
      <span>rendered offline</span>
      <span>© usage.fyi</span>
    </div>
  </footer>

</div>

<div class="toast" id="toast"></div>

<script>
  // mini heatmap (locked preview) — 14×5 grid
  (function () {
    const buckets = ['var(--h-0)','var(--h-1)','var(--h-2)','var(--h-3)','var(--h-4)','var(--h-5)'];
    let h = 7;
    function rng() { h = (h * 9301 + 49297) % 233280; return h / 233280; }
    const cells = 14 * 5;
    let html = '';
    for (let i = 0; i < cells; i++) {
      let v = Math.floor(Math.pow(rng(), 1.3) * 6);
      if (rng() < 0.18) v = 0;
      html += '<i style="background:' + buckets[v] + '"></i>';
    }
    document.getElementById('heatMini').innerHTML = html;
  })();

  // mini stacked bars (locked preview) — haiku/sonnet/opus columns
  (function () {
    const colors = ['var(--m-haiku)','var(--m-sonnet)','var(--m-opus)'];
    let h = 31;
    function rng() { h = (h * 9301 + 49297) % 233280; return h / 233280; }
    const cols = 9;
    let html = '';
    for (let i = 0; i < cols; i++) {
      const total = 22 + Math.floor(rng() * 20);
      const a = Math.floor((0.20 + rng()*0.20) * total);
      const b = Math.floor((0.35 + rng()*0.20) * total);
      const c = total - a - b;
      html += '<div class="col">' +
        '<span style="background:' + colors[0] + ';height:' + a + 'px"></span>' +
        '<span style="background:' + colors[1] + ';height:' + b + 'px"></span>' +
        '<span style="background:' + colors[2] + ';height:' + Math.max(2,c) + 'px"></span>' +
        '</div>';
    }
    document.getElementById('stackMini').innerHTML = html;
  })();

  const btn = document.getElementById("share");
  const result = document.getElementById("result");
  const urlEl = document.getElementById("url");
  const keyEl = document.getElementById("key");
  const errEl = document.getElementById("err");
  const toastEl = document.getElementById("toast");
  let toastTimer;

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.classList.add("publishing");
    const labelEl = btn.querySelector(".label");
    if (labelEl) labelEl.textContent = "publishing…";
    errEl.classList.remove("show");
    try {
      const res = await fetch("/share", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Share failed");
      urlEl.textContent = data.url;
      keyEl.textContent = data.manageKey;
      result.classList.add("show");
      btn.classList.remove("publishing");
      btn.classList.add("done");
      if (labelEl) labelEl.textContent = "published ✓";
      const viewerLink = document.getElementById("viewer-link");
      if (viewerLink) {
        viewerLink.href = data.url + "#mk=" + encodeURIComponent(data.manageKey);
        viewerLink.style.display = "";
      }
    } catch (e) {
      errEl.textContent = e.message || String(e);
      errEl.classList.add("show");
      btn.classList.remove("publishing");
      btn.disabled = false;
      if (labelEl) labelEl.textContent = "publish";
    }
  });

  for (const b of document.querySelectorAll("button[data-copy]")) {
    b.addEventListener("click", async () => {
      const id = b.getAttribute("data-copy");
      const text = document.getElementById(id).textContent;
      try {
        await navigator.clipboard.writeText(text);
        showToast("copied to clipboard");
      } catch {}
    });
  }
</script>
</body>
</html>`;
}

export async function runPreview(
  snapshot: Snapshot,
  _style: Style,
  apiBase: string,
): Promise<void> {
  let resolveExit: () => void;
  const exited = new Promise<void>((r) => {
    resolveExit = r;
  });

  const writeJson = (
    res: ServerResponse,
    status: number,
    body: unknown,
  ): void => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 4317;
      const html = buildHtml(snapshot, { apiBase, port });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && url.pathname === "/share") {
      try {
        const { id, manageKey } = await publishSnapshot(
          snapshot,
          _style,
          apiBase,
        );
        const body: ShareResponse = {
          id,
          url: `${apiBase}/s/${id}`,
          manageKey,
        };
        writeJson(res, 200, body);
      } catch (err) {
        if (err instanceof PublishError) {
          const { message } = resolvePublishError(err.status, err.body);
          const body: ErrorResponse = { error: message };
          writeJson(res, err.status, body);
          return;
        }
        const msg =
          err instanceof Error
            ? "Could not reach usage.fyi — check your connection."
            : String(err);
        const body: ErrorResponse = { error: msg };
        writeJson(res, 502, body);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const localUrl = `http://127.0.0.1:${port}`;
  console.log(`Preview: ${localUrl}  (Ctrl-C to stop)`);
  await openBrowser(localUrl);

  const shutdown = (): void => {
    server.close();
    resolveExit();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await exited;
}
