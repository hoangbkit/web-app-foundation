export const DEFAULT_ANALYTICS_ENDPOINT = "https://ai-proxy-server-staging.hoangbkit.workers.dev/v1/analytics/batch";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const FLUSH_INTERVAL_MS = 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;
const MAX_DAYS = 7;
const MAX_EVENTS_PER_DAY = 50;
const MAX_EVENT_COUNTERS_PER_BATCH = 100;
const MAX_EVENT_COUNT = 100_000;
const MAX_SESSION_COUNT = 1_000;
const MAX_SESSION_MS = 86_400_000;
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
const DIMENSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

interface DayState {
  sessions: number;
  sessionMs: number;
  events: Record<string, number>;
}

interface SessionState {
  lastActivityAt: number;
  activeSince: number | null;
}

interface AnalyticsState {
  installationId: string;
  days: Record<string, DayState>;
  session: SessionState | null;
  lastAttemptAt: number;
  lastSuccessfulFlushAt: number;
}

export interface AnalyticsEventCounter {
  name: string;
  count: number;
  dimension?: string;
}

export interface AnalyticsDaySnapshot {
  day: string;
  platform: "web";
  appVersion: string;
  sessions: number;
  sessionSeconds: number;
  events: AnalyticsEventCounter[];
}

export interface AnalyticsBatch {
  schemaVersion: 1;
  requestId: string;
  days: AnalyticsDaySnapshot[];
}

export interface AnalyticsRuntime {
  now: () => number;
  origin: string;
  storage: Pick<Storage, "getItem" | "setItem">;
  fetch: typeof fetch;
  randomUUID: () => string;
  visible: () => boolean;
}

export interface BrowserAnalyticsConfig {
  appId: string;
  appVersion: string | (() => string);
  productionOrigins: string | readonly string[];
  endpoint?: string;
  storageKey?: string;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function eventKey(name: string, dimension?: string): string {
  return `${name}\u0000${dimension ?? ""}`;
}

function parseEventKey(key: string): { name: string; dimension?: string } {
  const separator = key.indexOf("\u0000");
  const name = separator < 0 ? key : key.slice(0, separator);
  const dimension = separator < 0 ? "" : key.slice(separator + 1);
  return dimension ? { name, dimension } : { name };
}

function freshState(randomUUID: () => string): AnalyticsState {
  return {
    installationId: randomUUID(),
    days: {},
    session: null,
    lastAttemptAt: 0,
    lastSuccessfulFlushAt: 0,
  };
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validStoredEvent(key: string, count: unknown): boolean {
  const event = parseEventKey(key);
  return EVENT_NAME_PATTERN.test(event.name)
    && (event.dimension === undefined || (event.dimension.length <= 64 && DIMENSION_PATTERN.test(event.dimension)))
    && validNumber(count);
}

function validDayState(value: unknown): value is DayState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<DayState>;
  if (!validNumber(candidate.sessions) || !validNumber(candidate.sessionMs)) return false;
  if (!candidate.events || typeof candidate.events !== "object" || Array.isArray(candidate.events)) return false;
  return Object.entries(candidate.events).every(([key, count]) => validStoredEvent(key, count));
}

function validSession(value: unknown): value is SessionState | null {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SessionState>;
  return validNumber(candidate.lastActivityAt)
    && (candidate.activeSince === null || validNumber(candidate.activeSince));
}

function loadState(
  storage: AnalyticsRuntime["storage"],
  storageKey: string,
  randomUUID: () => string,
): AnalyticsState {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return freshState(randomUUID);
    const parsed = JSON.parse(raw) as Partial<AnalyticsState>;
    if (
      typeof parsed.installationId !== "string"
      || parsed.installationId.length < 8
      || !parsed.days
      || typeof parsed.days !== "object"
      || Array.isArray(parsed.days)
      || !Object.values(parsed.days).every(validDayState)
      || !validSession(parsed.session)
      || !validNumber(parsed.lastAttemptAt)
      || !validNumber(parsed.lastSuccessfulFlushAt)
    ) return freshState(randomUUID);
    return {
      installationId: parsed.installationId,
      days: parsed.days,
      session: parsed.session ?? null,
      lastAttemptAt: parsed.lastAttemptAt,
      lastSuccessfulFlushAt: parsed.lastSuccessfulFlushAt,
    };
  } catch {
    return freshState(randomUUID);
  }
}

function dayBucket(state: AnalyticsState, day: string): DayState {
  const existing = state.days[day];
  if (existing) return existing;
  const created: DayState = { sessions: 0, sessionMs: 0, events: {} };
  state.days[day] = created;
  return created;
}

function pruneDays(state: AnalyticsState, now: number): void {
  const minimum = utcDay(now - (MAX_DAYS - 1) * 86_400_000);
  const today = utcDay(now);
  for (const day of Object.keys(state.days)) {
    if (day < minimum || day > today) delete state.days[day];
  }
}

function totalEventCounters(state: AnalyticsState): number {
  return Object.values(state.days).reduce((total, day) => total + Object.keys(day.events).length, 0);
}

function addActiveDuration(state: AnalyticsState, start: number, end: number): void {
  let cursor = start;
  while (cursor < end) {
    const date = new Date(cursor);
    const nextDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
    const segmentEnd = Math.min(end, nextDay);
    const bucket = dayBucket(state, utcDay(cursor));
    bucket.sessionMs = Math.min(MAX_SESSION_MS, bucket.sessionMs + Math.max(0, segmentEnd - cursor));
    cursor = segmentEnd;
  }
}

function settleActiveSegment(state: AnalyticsState, now: number): void {
  const session = state.session;
  if (!session || session.activeSince === null) return;
  const end = Math.min(now, session.lastActivityAt + SESSION_TIMEOUT_MS);
  if (end > session.activeSince) addActiveDuration(state, session.activeSince, end);
  session.activeSince = end >= now ? now : null;
}

function markActivity(state: AnalyticsState, now: number, visible: boolean): void {
  const session = state.session;
  if (!session || now - session.lastActivityAt >= SESSION_TIMEOUT_MS) {
    settleActiveSegment(state, now);
    const bucket = dayBucket(state, utcDay(now));
    bucket.sessions = Math.min(MAX_SESSION_COUNT, bucket.sessions + 1);
    state.session = { lastActivityAt: now, activeSince: visible ? now : null };
    return;
  }

  settleActiveSegment(state, now);
  session.lastActivityAt = now;
  if (visible) session.activeSince = now;
}

function normalizeDimension(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const compact = trimmed.slice(0, 64);
  return DIMENSION_PATTERN.test(compact) ? compact : undefined;
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function browserRandomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function volatileStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

function browserRuntime(): AnalyticsRuntime {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Browser analytics can only be created in a browser environment.");
  }

  let storage: Pick<Storage, "getItem" | "setItem">;
  try {
    storage = window.localStorage;
  } catch {
    storage = volatileStorage();
  }

  return {
    now: () => Date.now(),
    origin: window.location.origin,
    storage,
    fetch: window.fetch.bind(window),
    randomUUID: browserRandomUUID,
    visible: () => document.visibilityState === "visible",
  };
}

export class BrowserAnalytics {
  private readonly runtime: AnalyticsRuntime;
  private readonly appId: string;
  private readonly appVersion: () => string;
  private readonly endpoint: string;
  private readonly storageKey: string;
  private readonly productionOrigins: ReadonlySet<string>;
  private state: AnalyticsState;
  private started = false;
  private inFlight: Promise<void> | null = null;
  private cleanup: Array<() => void> = [];
  private revision = 0;
  private flushedRevision = 0;

  constructor(config: BrowserAnalyticsConfig, runtime: AnalyticsRuntime = browserRuntime()) {
    this.runtime = runtime;
    this.appId = config.appId;
    this.appVersion = typeof config.appVersion === "function" ? config.appVersion : () => config.appVersion as string;
    this.endpoint = config.endpoint ?? DEFAULT_ANALYTICS_ENDPOINT;
    this.storageKey = config.storageKey ?? `web-app-foundation.analytics.${config.appId}.v1`;
    const origins = typeof config.productionOrigins === "string" ? [config.productionOrigins] : config.productionOrigins;
    this.productionOrigins = new Set(origins.map(normalizeOrigin));
    this.state = loadState(runtime.storage, this.storageKey, runtime.randomUUID);
    pruneDays(this.state, runtime.now());
    if (Object.keys(this.state.days).length > 0) this.revision = 1;
  }

  get enabled(): boolean {
    return this.productionOrigins.has(normalizeOrigin(this.runtime.origin));
  }

  private get dirty(): boolean {
    return this.revision > this.flushedRevision;
  }

  private markDirty(): void {
    this.revision += 1;
  }

  start(): void {
    if (!this.enabled || this.started || typeof window === "undefined" || typeof document === "undefined") return;
    this.started = true;
    this.activity();

    const activity = () => this.activity();
    const hide = () => {
      const now = this.runtime.now();
      settleActiveSegment(this.state, now);
      if (this.state.session) this.state.session.activeSince = null;
      this.markDirty();
      this.persist();
      void this.flushOnHide();
    };
    const visibility = () => {
      if (this.runtime.visible()) {
        markActivity(this.state, this.runtime.now(), true);
        this.markDirty();
      } else {
        hide();
      }
    };
    const flushTimer = window.setInterval(() => {
      if (this.dirty) void this.flush(false);
    }, FLUSH_INTERVAL_MS);

    window.addEventListener("pointerdown", activity, { passive: true });
    window.addEventListener("keydown", activity, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", hide);
    this.cleanup = [
      () => window.removeEventListener("pointerdown", activity),
      () => window.removeEventListener("keydown", activity),
      () => document.removeEventListener("visibilitychange", visibility),
      () => window.removeEventListener("pagehide", hide),
      () => window.clearInterval(flushTimer),
    ];
  }

  stop(): void {
    for (const dispose of this.cleanup) dispose();
    this.cleanup = [];
    this.started = false;
  }

  track(name: string, dimension?: string): void {
    if (!this.enabled || !EVENT_NAME_PATTERN.test(name)) return;
    const now = this.runtime.now();
    pruneDays(this.state, now);
    markActivity(this.state, now, this.runtime.visible());
    const bucket = dayBucket(this.state, utcDay(now));
    const normalizedDimension = normalizeDimension(dimension);
    const key = eventKey(name, normalizedDimension);
    const newCounter = !(key in bucket.events);
    if (newCounter && Object.keys(bucket.events).length >= MAX_EVENTS_PER_DAY) return;
    if (newCounter && totalEventCounters(this.state) >= MAX_EVENT_COUNTERS_PER_BATCH) return;
    bucket.events[key] = Math.min(MAX_EVENT_COUNT, (bucket.events[key] ?? 0) + 1);
    this.markDirty();
    this.persist();
  }

  buildBatch(now = this.runtime.now()): AnalyticsBatch | null {
    settleActiveSegment(this.state, now);
    pruneDays(this.state, now);
    const days = Object.keys(this.state.days).sort().map((day) => {
      const bucket = this.state.days[day]!;
      const events = Object.entries(bucket.events).map(([key, count]) => ({
        ...parseEventKey(key),
        count: Math.min(MAX_EVENT_COUNT, Math.max(0, Math.floor(count))),
      }));
      return {
        day,
        platform: "web" as const,
        appVersion: this.appVersion(),
        sessions: Math.min(MAX_SESSION_COUNT, Math.max(0, Math.floor(bucket.sessions))),
        sessionSeconds: Math.min(86_400, Math.max(0, Math.floor(bucket.sessionMs / 1000))),
        events,
      };
    });
    if (days.length === 0) return null;
    return { schemaVersion: 1, requestId: `web-${this.runtime.randomUUID()}`, days };
  }

  async flush(force = false): Promise<void> {
    if (!this.enabled || this.inFlight || !this.dirty) return this.inFlight ?? Promise.resolve();
    const now = this.runtime.now();
    if (now - this.state.lastAttemptAt < RETRY_INTERVAL_MS) return;
    if (!force && now - this.state.lastSuccessfulFlushAt < FLUSH_INTERVAL_MS) return;
    const batch = this.buildBatch(now);
    if (!batch) return;
    const sentRevision = this.revision;

    this.state.lastAttemptAt = now;
    this.persist();
    this.inFlight = this.runtime.fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-app-id": this.appId,
        "x-installation-id": this.state.installationId,
      },
      body: JSON.stringify(batch),
      keepalive: force,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }).then((response) => {
      if (!response.ok) return;
      this.state.lastSuccessfulFlushAt = now;
      this.flushedRevision = Math.max(this.flushedRevision, sentRevision);
      this.persist();
    }).catch(() => {
      // Cumulative snapshots remain local and can be retried later.
    }).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private activity(): void {
    if (!this.enabled) return;
    markActivity(this.state, this.runtime.now(), this.runtime.visible());
    this.markDirty();
  }

  private flushOnHide(): Promise<void> {
    return this.flush(true);
  }

  private persist(): void {
    pruneDays(this.state, this.runtime.now());
    try {
      this.runtime.storage.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      // Analytics must never interfere with the host app when storage is unavailable.
    }
  }
}

export function createBrowserAnalytics(config: BrowserAnalyticsConfig): BrowserAnalytics {
  return new BrowserAnalytics(config);
}
