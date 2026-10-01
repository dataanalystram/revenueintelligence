import { Global, Injectable, Module } from '@nestjs/common';
import { metrics, type Counter, type Histogram } from '@opentelemetry/api';

/** Label values are short codes (queue, job, outcome, tenant slug): never ids or personal data. */
export type MetricLabels = Readonly<Record<string, string>>;

const LABEL_VALUE = /^[a-z0-9_.:-]{1,64}$/;

function key(name: string, labels: MetricLabels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

/**
 * Process metrics (M6 observability). Instruments are OpenTelemetry metrics,
 * exported when OTEL is enabled; an in-process copy backs `snapshot()` for
 * tests, reports and log summaries. Labels are validated so a record id or
 * an email address can never become a metric label.
 */
@Injectable()
export class MetricsService {
  private readonly meter = metrics.getMeter('lead-intelligence-platform');
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly counts = new Map<string, number>();
  private readonly sums = new Map<string, { count: number; sum: number; max: number }>();

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    this.check(labels);
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    counter.add(by, labels);
    const k = key(name, labels);
    this.counts.set(k, (this.counts.get(k) ?? 0) + by);
  }

  record(name: string, value: number, labels: MetricLabels = {}): void {
    this.check(labels);
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = this.meter.createHistogram(name);
      this.histograms.set(name, histogram);
    }
    histogram.record(value, labels);
    const k = key(name, labels);
    const s = this.sums.get(k) ?? { count: 0, sum: 0, max: 0 };
    this.sums.set(k, { count: s.count + 1, sum: s.sum + value, max: Math.max(s.max, value) });
  }

  /** Counter values and histogram summaries, keyed `name{label=value,…}`. */
  snapshot(): {
    counters: Record<string, number>;
    histograms: Record<string, { count: number; sum: number; max: number }>;
  } {
    return {
      counters: Object.fromEntries(this.counts),
      histograms: Object.fromEntries(this.sums),
    };
  }

  /** Sum of a counter across all label sets matching `labels`. */
  total(name: string, labels: MetricLabels = {}): number {
    let sum = 0;
    for (const [k, v] of this.counts) {
      if (k !== name && !k.startsWith(`${name}{`)) continue;
      if (Object.entries(labels).every(([lk, lv]) => k.includes(`${lk}=${lv}`))) sum += v;
    }
    return sum;
  }

  private check(labels: MetricLabels): void {
    for (const [k, v] of Object.entries(labels)) {
      if (!LABEL_VALUE.test(k) || !LABEL_VALUE.test(v)) {
        throw new RangeError(`metric label ${k} has a value that is not a short code`);
      }
    }
  }
}

@Global()
@Module({ providers: [MetricsService], exports: [MetricsService] })
export class MetricsModule {}
