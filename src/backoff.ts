/**
 * Jittered decorrelated exponential backoff.
 *
 *   next = random(base, min(cap, previous * 3))
 *
 * Matches the AWS decorrelated-jitter recipe.
 */
export class Backoff {
  private readonly baseMs: number;
  private readonly capMs: number;
  private previousMs: number;

  constructor(baseMs = 250, capMs = 30000) {
    this.baseMs = baseMs;
    this.capMs = capMs;
    this.previousMs = baseMs;
  }

  nextMs(): number {
    const upper = Math.min(this.capMs, this.previousMs * 3);
    const lo = this.baseMs;
    const hi = upper <= lo ? lo + 1 : upper;
    const next = Math.floor(lo + Math.random() * (hi - lo));
    this.previousMs = next;
    return next;
  }

  reset(): void {
    this.previousMs = this.baseMs;
  }
}
