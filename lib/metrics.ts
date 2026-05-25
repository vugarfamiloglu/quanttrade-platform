/**
 * Prometheus-shape metrics — counters and histograms exposed via
 * /metrics in text exposition format.
 *
 * Trading systems live or die by histogram tails — a P50 of 200μs
 * means nothing if the P99 is 50ms.  Every meaningful operation
 * records a histogram observation so we can compute P50/P95/P99/P999
 * over arbitrary windows in Grafana.
 */

class Counter {
  constructor(public name: string, public help: string, public labels: string[] = []) {}
  private values = new Map<string, number>();
  inc(labels: Record<string, string> = {}, by = 1): void {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  expose(): string {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values.entries()) out.push(`${this.name}${k} ${v}`);
    return out.join('\n');
  }
  toJSON() { return Object.fromEntries(this.values); }
}

class Histogram {
  constructor(public name: string, public help: string, public buckets: number[] = DEFAULT_BUCKETS) {}
  private bucketCounts = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();
  observe(value: number, labels: Record<string, string> = {}): void {
    const k = labelKey(labels);
    let bc = this.bucketCounts.get(k);
    if (!bc) { bc = this.buckets.map(() => 0); this.bucketCounts.set(k, bc); }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]) bc[i]++;
    this.sums.set(k, (this.sums.get(k) ?? 0) + value);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }
  expose(): string {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, bc] of this.bucketCounts.entries()) {
      const labelPart = k.replace(/^\{|}$/g, '');
      for (let i = 0; i < this.buckets.length; i++) {
        const le = this.buckets[i].toString();
        const sep = labelPart ? ',' : '';
        out.push(`${this.name}_bucket{${labelPart}${sep}le="${le}"} ${bc[i]}`);
      }
      const sep = labelPart ? ',' : '';
      out.push(`${this.name}_bucket{${labelPart}${sep}le="+Inf"} ${this.counts.get(k) ?? 0}`);
      out.push(`${this.name}_sum${k} ${this.sums.get(k) ?? 0}`);
      out.push(`${this.name}_count${k} ${this.counts.get(k) ?? 0}`);
    }
    return out.join('\n');
  }
  /** Compute quantile from the histogram at the given label set. */
  quantile(q: number, labels: Record<string, string> = {}): number {
    const k = labelKey(labels);
    const bc = this.bucketCounts.get(k);
    const total = this.counts.get(k) ?? 0;
    if (!bc || total === 0) return 0;
    const target = total * q;
    let cumulative = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      cumulative += bc[i] - (i > 0 ? bc[i - 1] : 0);
      if (cumulative >= target) return this.buckets[i];
    }
    return this.buckets[this.buckets.length - 1];
  }
  toJSON() {
    const out: Record<string, any> = {};
    for (const k of this.bucketCounts.keys()) {
      out[k] = {
        count: this.counts.get(k) ?? 0,
        sum:   this.sums.get(k) ?? 0,
        p50:   this.quantile(0.50, parseLabels(k)),
        p95:   this.quantile(0.95, parseLabels(k)),
        p99:   this.quantile(0.99, parseLabels(k)),
      };
    }
    return out;
  }
}

const DEFAULT_BUCKETS = [
  0.000_05, 0.000_1, 0.000_25, 0.000_5,    // 50μs..500μs (matching range)
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

function labelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}="${labels[k]}"`).join(',') + '}';
}
function parseLabels(k: string): Record<string, string> {
  if (!k) return {};
  const body = k.slice(1, -1);
  const out: Record<string, string> = {};
  for (const part of body.split(',')) {
    const m = part.match(/^([^=]+)="([^"]*)"$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const counters   = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();

export function counter(name: string, help: string): Counter {
  let c = counters.get(name);
  if (!c) { c = new Counter(name, help); counters.set(name, c); }
  return c;
}
export function histogram(name: string, help: string, buckets?: number[]): Histogram {
  let h = histograms.get(name);
  if (!h) { h = new Histogram(name, help, buckets); histograms.set(name, h); }
  return h;
}

export function exposeMetrics(): string {
  const out: string[] = [];
  for (const c of counters.values())   out.push(c.expose());
  for (const h of histograms.values()) out.push(h.expose());
  return out.join('\n\n') + '\n';
}

export function metricsSnapshot() {
  const out: Record<string, any> = { counters: {}, histograms: {} };
  for (const [name, c] of counters.entries())   out.counters[name]   = c.toJSON();
  for (const [name, h] of histograms.entries()) out.histograms[name] = h.toJSON();
  return out;
}
