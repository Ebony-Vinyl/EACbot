import type { AgentEvent } from "../contracts.ts";

type Waiter = {
  resolve: (result: IteratorResult<AgentEvent>) => void;
  reject: (error: Error) => void;
};

/** A bounded queue an adapter pushes native events into and a consumer pulls with `for await`.
 * Bounded because a stalled consumer must never let an engine's event backlog grow without limit. */
export class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly items: AgentEvent[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;
  private failure: Error | null = null;

  private readonly capacity: number;

  constructor(capacity = 1024) {
    this.capacity = capacity;
  }

  push(event: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    if (this.items.length >= this.capacity) this.items.shift();
    this.items.push(event);
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = reason ?? null;
    for (const waiter of this.waiters.splice(0)) {
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<AgentEvent>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

let counter = 0;

/** One variant of an event without its envelope: distributing over the union keeps each
 * variant's own fields required. */
export type AgentEventInput = AgentEvent extends infer Variant
  ? Variant extends AgentEvent
    ? Omit<Variant, "eventId" | "sessionId" | "turnId" | "at">
    : never
  : never;

/** One envelope factory, so every adapter stamps ids and timestamps identically. */
export function eventFactory() {
  return (sessionId: string, turnId: string | null, event: AgentEventInput): AgentEvent =>
    ({
      eventId: `ev-${Date.now().toString(36)}-${(counter++).toString(36)}`,
      sessionId,
      turnId,
      at: new Date().toISOString(),
      ...event,
    }) as AgentEvent;
}
