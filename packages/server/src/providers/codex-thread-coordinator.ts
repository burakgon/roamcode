import { ProviderError } from "./types.js";

export interface CodexSpawnLease {
  readonly started: Promise<void>;
  cancel(): Promise<void>;
}

interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: ProviderError) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
}

function unavailable(): ProviderError {
  return new ProviderError("RESUME_IDENTITY_UNAVAILABLE", "Codex resume identity is unavailable");
}

class CodexThreadResolutionCoordinator {
  private locked = false;
  private poisoned = false;
  private readonly queue: Waiter[] = [];

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.poisoned || signal?.aborted) return Promise.reject(unavailable());
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(unavailable());
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      if (!this.locked) {
        this.locked = true;
        this.grant(waiter);
      } else {
        this.queue.push(waiter);
      }
    });
  }

  async acknowledgeCancellation(lease: CodexSpawnLease, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const acknowledgement: unknown = lease.cancel();
      if (!(acknowledgement instanceof Promise)) throw unavailable();
      await Promise.race([
        acknowledgement,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(unavailable()), timeoutMs);
          (timer as NodeJS.Timeout).unref?.();
        }),
      ]);
    } catch {
      this.poison();
      throw unavailable();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A launch callback ran but did not return a cancellable lease, so later discovery is permanently unsafe. */
  poisonUnknownSpawnOutcome(): void {
    this.poison();
  }

  resetForTests(): void {
    if (process.env.NODE_ENV !== "test" || this.locked || this.queue.length > 0) throw unavailable();
    this.poisoned = false;
  }

  private poison(): void {
    this.poisoned = true;
    for (const waiter of this.queue.splice(0)) {
      if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(unavailable());
    }
  }

  private grant(waiter: Waiter): void {
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    if (this.poisoned) {
      waiter.reject(unavailable());
      this.locked = false;
      return;
    }
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) this.grant(next);
      else this.locked = false;
    });
  }
}

export const codexThreadResolutionCoordinator = new CodexThreadResolutionCoordinator();
