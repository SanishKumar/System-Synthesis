/**
 * Prometheus Metrics Collector
 *
 * Lightweight metrics collection for System Synthesis.
 * Exposes a /metrics endpoint in Prometheus text format.
 * No external dependencies — pure TypeScript counters/gauges/histograms.
 */

import type { Request, Response } from "express";

// ── Counter ──

class Counter {
  private value = 0;
  constructor(
    public readonly name: string,
    public readonly help: string,
    private labels: string[] = []
  ) {}

  inc(amount = 1) {
    this.value += amount;
  }

  get() {
    return this.value;
  }

  toPrometheus(): string {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
      `${this.name} ${this.value}`,
    ].join("\n");
  }
}

// ── Gauge ──

class Gauge {
  private value = 0;
  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}

  set(v: number) {
    this.value = v;
  }

  inc(amount = 1) {
    this.value += amount;
  }

  dec(amount = 1) {
    this.value -= amount;
  }

  get() {
    return this.value;
  }

  toPrometheus(): string {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
      `${this.name} ${this.value}`,
    ].join("\n");
  }
}

// ── Histogram (simplified — just tracks count, sum, and basic buckets) ──

class Histogram {
  private count = 0;
  private sum = 0;
  private buckets: Map<number, number>;

  constructor(
    public readonly name: string,
    public readonly help: string,
    bucketBoundaries: number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
  ) {
    this.buckets = new Map();
    for (const b of bucketBoundaries) {
      this.buckets.set(b, 0);
    }
  }

  observe(value: number) {
    this.count++;
    this.sum += value;
    for (const [boundary, count] of this.buckets) {
      if (value <= boundary) {
        this.buckets.set(boundary, count + 1);
      }
    }
  }

  toPrometheus(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const [boundary, count] of this.buckets) {
      lines.push(`${this.name}_bucket{le="${boundary}"} ${count}`);
    }
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`);
    lines.push(`${this.name}_sum ${this.sum}`);
    lines.push(`${this.name}_count ${this.count}`);
    return lines.join("\n");
  }
}

// ── Metrics Registry ──

export const metrics = {
  // HTTP
  httpRequestsTotal: new Counter(
    "ss_http_requests_total",
    "Total HTTP requests received"
  ),
  httpErrorsTotal: new Counter(
    "ss_http_errors_total",
    "Total HTTP 4xx/5xx responses"
  ),
  httpRequestDuration: new Histogram(
    "ss_http_request_duration_ms",
    "HTTP request duration in milliseconds"
  ),

  // WebSocket
  wsConnectionsActive: new Gauge(
    "ss_ws_connections_active",
    "Currently active WebSocket connections"
  ),
  wsConnectionsTotal: new Counter(
    "ss_ws_connections_total",
    "Total WebSocket connections since startup"
  ),

  // Boards
  boardsTotal: new Gauge(
    "ss_boards_total",
    "Total boards in the system"
  ),
  boardSaveDuration: new Histogram(
    "ss_board_save_duration_ms",
    "Board save (Redis + Postgres) duration in milliseconds"
  ),

  // AI
  aiCallsTotal: new Counter(
    "ss_ai_calls_total",
    "Total AI analysis/generate calls"
  ),
  aiCallDuration: new Histogram(
    "ss_ai_call_duration_ms",
    "AI call duration in milliseconds"
  ),
  aiErrorsTotal: new Counter(
    "ss_ai_errors_total",
    "Total failed AI calls"
  ),

  // Exports
  exportsTotal: new Counter(
    "ss_exports_total",
    "Total export operations (Docker, Terraform, Report)"
  ),

  // Validation
  validationsTotal: new Counter(
    "ss_validations_total",
    "Total validation runs"
  ),
};

// ── Metrics endpoint handler ──

export function metricsHandler(_req: Request, res: Response) {
  // Also set uptime gauge
  const uptimeGauge = new Gauge("ss_uptime_seconds", "Server uptime in seconds");
  uptimeGauge.set(Math.floor(process.uptime()));

  const memUsage = process.memoryUsage();
  const memGauge = new Gauge("ss_memory_rss_bytes", "Resident set size in bytes");
  memGauge.set(memUsage.rss);

  const body = [
    // Static gauges
    uptimeGauge.toPrometheus(),
    memGauge.toPrometheus(),
    "",
    // Dynamic metrics
    ...Object.values(metrics).map((m) => m.toPrometheus()),
  ].join("\n\n");

  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(body + "\n");
}
