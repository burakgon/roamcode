import { randomUUID } from "node:crypto";
import type {
  SessionAutomationActivity,
  SessionAutomationConfiguredTrigger,
  SessionAutomationDefinition,
  SessionAutomationStore,
} from "./session-automation-store.js";

interface CronField {
  any: boolean;
  values: Set<number>;
}

export interface AutomationTriggerEngine {
  start(): void;
  stop(): void;
  tick(now?: number): Promise<void>;
  enqueueWebhook(
    automation: SessionAutomationDefinition,
    trigger: SessionAutomationConfiguredTrigger,
    externalInvocationId?: string,
  ): SessionAutomationActivity;
}

export interface AutomationTriggerEngineOptions {
  store: SessionAutomationStore;
  execute: (activity: SessionAutomationActivity) => Promise<{ runId: string }>;
  concurrency?: number;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

function parsePart(part: string, min: number, max: number, normalize?: (value: number) => number): number[] {
  const [rangePart, stepPart] = part.split("/");
  const step = stepPart === undefined ? 1 : Number(stepPart);
  if (!Number.isSafeInteger(step) || step < 1 || !rangePart) throw new Error("invalid cron field");
  let start: number;
  let end: number;
  if (rangePart === "*") {
    start = min;
    end = max;
  } else if (rangePart.includes("-")) {
    const pair = rangePart.split("-");
    if (pair.length !== 2) throw new Error("invalid cron field");
    start = Number(pair[0]);
    end = Number(pair[1]);
  } else {
    start = Number(rangePart);
    end = start;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < min || end > max || start > end) {
    throw new Error("invalid cron field");
  }
  const values: number[] = [];
  for (let value = start; value <= end; value += step) values.push(normalize ? normalize(value) : value);
  return values;
}

function parseField(source: string, min: number, max: number, normalize?: (value: number) => number): CronField {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    for (const value of parsePart(part, min, max, normalize)) values.add(value);
  }
  return { any: source === "*", values };
}

export function validateCronExpression(expression: string): string {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const fields = normalized.split(" ");
  if (fields.length !== 5) throw new Error("cron must contain five fields");
  parseField(fields[0]!, 0, 59);
  parseField(fields[1]!, 0, 23);
  parseField(fields[2]!, 1, 31);
  parseField(fields[3]!, 1, 12);
  parseField(fields[4]!, 0, 7, (value) => (value === 7 ? 0 : value));
  return normalized;
}

function zonedParts(
  time: number,
  timeZone: string,
): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  }).formatToParts(time);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(byType.get("weekday") ?? "");
  return {
    minute: Number(byType.get("minute")),
    hour: Number(byType.get("hour")),
    day: Number(byType.get("day")),
    month: Number(byType.get("month")),
    weekday,
  };
}

export function cronMatches(expression: string, timeZone: string, time: number): boolean {
  const fields = validateCronExpression(expression).split(" ");
  const minute = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const day = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12);
  const weekday = parseField(fields[4]!, 0, 7, (value) => (value === 7 ? 0 : value));
  const value = zonedParts(time, timeZone);
  const dayMatches = day.values.has(value.day);
  const weekdayMatches = weekday.values.has(value.weekday);
  const calendarMatches =
    day.any && weekday.any ? true : day.any ? weekdayMatches : weekday.any ? dayMatches : dayMatches || weekdayMatches;
  return (
    minute.values.has(value.minute) && hour.values.has(value.hour) && month.values.has(value.month) && calendarMatches
  );
}

function invocationId(source: "schedule" | "webhook", automationId: string, triggerId: string, nonce: string): string {
  const safeNonce = nonce.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 96);
  return `rci_${source}_${automationId}_${triggerId}_${safeNonce}`.slice(0, 256);
}

export function createAutomationTriggerEngine(options: AutomationTriggerEngineOptions): AutomationTriggerEngine {
  const now = options.now ?? Date.now;
  const interval = options.setInterval ?? globalThis.setInterval;
  const clearInterval = options.clearInterval ?? globalThis.clearInterval;
  const concurrency =
    Number.isSafeInteger(options.concurrency) && (options.concurrency ?? 0) > 0 ? options.concurrency! : 2;
  const pending: SessionAutomationActivity[] = [];
  const pendingIds = new Set<string>();
  const inFlightIds = new Set<string>();
  let active = 0;
  let ticking = false;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const queue = (activity: SessionAutomationActivity, deferDrain = false) => {
    if (activity.status !== "queued" || pendingIds.has(activity.id) || inFlightIds.has(activity.id)) return;
    pendingIds.add(activity.id);
    pending.push(activity);
    pending.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    if (!deferDrain) drain();
  };

  const drain = () => {
    while (active < concurrency && pending.length > 0) {
      const activity = pending.shift()!;
      pendingIds.delete(activity.id);
      inFlightIds.add(activity.id);
      active += 1;
      void options
        .execute(activity)
        .then(({ runId }) => options.store.updateActivity(activity.id, { status: "started", runId }))
        .catch(() =>
          options.store.updateActivity(activity.id, { status: "failed", failureCode: "TRIGGER_EXECUTION_FAILED" }),
        )
        .finally(() => {
          inFlightIds.delete(activity.id);
          active -= 1;
          drain();
        });
    }
  };

  const createQueued = (
    automation: SessionAutomationDefinition,
    trigger: SessionAutomationConfiguredTrigger,
    source: "schedule" | "webhook",
    nonce: string,
    scheduledFor?: number,
  ): SessionAutomationActivity => {
    const id = invocationId(source, automation.id, trigger.id, nonce);
    const existing = options.store.getActivityByInvocationId(id);
    if (existing) {
      queue(existing);
      return existing;
    }
    const activity = options.store.createActivity({
      automationId: automation.id,
      triggerId: trigger.id,
      source,
      status: "queued",
      invocationId: id,
      ...(scheduledFor === undefined ? {} : { scheduledFor }),
    });
    queue(activity);
    return activity;
  };

  const tick = async (at = now()): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const currentMinute = Math.floor(at / 60_000);
      for (const automation of options.store.list()) {
        if (!automation.enabled) continue;
        for (const trigger of automation.triggers) {
          if (trigger.type !== "schedule" || !trigger.enabled) continue;
          const previous = options.store.getTriggerCursor(trigger.id) ?? currentMinute - 1;
          if (previous >= currentMinute) continue;
          const firstMinute = Math.max(previous + 1, currentMinute - 43_200);
          const matches: number[] = [];
          for (let minute = firstMinute; minute <= currentMinute; minute += 1) {
            if (cronMatches(trigger.cron, trigger.timeZone, minute * 60_000)) matches.push(minute);
          }
          const missed = matches.filter((minute) => minute < currentMinute);
          if (missed.length > 0) {
            const missedInvocation = invocationId("schedule", automation.id, trigger.id, `missed-${currentMinute}`);
            const exists = options.store
              .listActivities(automation.id, 1000)
              .some((activity) => activity.invocationId === missedInvocation);
            if (!exists) {
              options.store.createActivity({
                automationId: automation.id,
                triggerId: trigger.id,
                source: "schedule",
                status: "missed",
                invocationId: missedInvocation,
                scheduledFor: missed[missed.length - 1]! * 60_000,
                missedCount: missed.length,
                failureCode: "NODE_OFFLINE_MISSED_SCHEDULE",
              });
            }
          }
          if (matches.includes(currentMinute)) {
            createQueued(automation, trigger, "schedule", String(currentMinute), currentMinute * 60_000);
          }
          options.store.setTriggerCursor(trigger.id, currentMinute);
        }
      }
    } finally {
      ticking = false;
    }
  };

  return {
    start() {
      if (timer) return;
      for (const activity of options.store.listActivities(undefined, 1000)) queue(activity, true);
      drain();
      void tick();
      timer = interval(() => void tick(), 15_000);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
    tick,
    enqueueWebhook(automation, trigger, externalInvocationId) {
      if (trigger.type !== "webhook") throw new Error("invalid webhook trigger");
      return createQueued(automation, trigger, "webhook", externalInvocationId ?? randomUUID());
    },
  };
}
