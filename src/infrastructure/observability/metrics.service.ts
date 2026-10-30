import { Injectable } from "@nestjs/common";

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();

  increment(name: string, count = 1): number {
    const current = this.counters.get(name) ?? 0;
    const next = current + count;
    this.counters.set(name, next);
    return next;
  }

  observe(name: string, value: number): void {
    this.increment(`${name}.count`);
    this.increment(`${name}.sum`, value);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(
      [...this.counters.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  }
}
