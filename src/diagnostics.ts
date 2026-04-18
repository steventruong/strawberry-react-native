import { redactionCount } from './redactor';

export type BreakerState = 'CLOSED' | 'HALF_OPEN' | 'OPEN';

export interface DiagnosticsSnapshot {
  queue_depth: number;
  drops: number;
  retries: number;
  failures: number;
  breaker_state: BreakerState;
  redaction_count: number;
}

class DiagnosticsState {
  queueDepth = 0;
  drops = 0;
  retries = 0;
  failures = 0;
  breaker: BreakerState = 'CLOSED';

  recordDrop(): void {
    this.drops++;
  }

  recordRetry(): void {
    this.retries++;
  }

  recordFailure(): void {
    this.failures++;
  }

  setQueueDepth(v: number): void {
    this.queueDepth = v;
  }

  snapshot(): DiagnosticsSnapshot {
    return {
      queue_depth: this.queueDepth,
      drops: this.drops,
      retries: this.retries,
      failures: this.failures,
      breaker_state: this.breaker,
      redaction_count: redactionCount(),
    };
  }
}

export const diagnosticsState = new DiagnosticsState();

export function diagnosticsSnapshot(): DiagnosticsSnapshot {
  return diagnosticsState.snapshot();
}
