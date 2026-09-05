import { describe, expect, it } from "vitest";
import {
  BrowserAnalytics,
  DEFAULT_ANALYTICS_ENDPOINT,
  type AnalyticsRuntime,
  type BrowserAnalyticsConfig,
} from "../src/analytics.js";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const baseConfig: BrowserAnalyticsConfig = {
  appId: "chat-byok-pro",
  appVersion: "0.1.0+test",
  productionOrigins: "https://chat.byok.pro",
};

function clock(options: {
  now?: number;
  origin?: string;
  fetch?: typeof fetch;
  storage?: MemoryStorage;
} = {}) {
  let now = options.now ?? Date.UTC(2026, 8, 4, 12, 0, 0);
  const storage = options.storage ?? new MemoryStorage();
  let sequence = 0;
  const runtime: AnalyticsRuntime = {
    now: () => now,
    origin: options.origin ?? "https://chat.byok.pro",
    storage,
    fetch: options.fetch ?? (async () => new Response("{}", { status: 200 })),
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    visible: () => true,
  };
  return {
    runtime,
    storage,
    advance(milliseconds: number) { now += milliseconds; },
  };
}

describe("BrowserAnalytics", () => {
  it("builds the server v1 cumulative web snapshot without raw content", () => {
    const time = clock();
    const analytics = new BrowserAnalytics(baseConfig, time.runtime);

    analytics.track("message_sent");
    analytics.track("provider_used", "openai");
    analytics.track("model_used", "gpt-5.6");

    const batch = analytics.buildBatch();
    expect(batch).not.toBeNull();
    expect(batch?.schemaVersion).toBe(1);
    expect(batch?.requestId).toMatch(/^web-/);
    expect(batch?.days).toHaveLength(1);
    expect(batch?.days[0]).toMatchObject({
      day: "2026-09-04",
      platform: "web",
      appVersion: "0.1.0+test",
      sessions: 1,
      events: [
        { name: "message_sent", count: 1 },
        { name: "provider_used", dimension: "openai", count: 1 },
        { name: "model_used", dimension: "gpt-5.6", count: 1 },
      ],
    });
    expect(JSON.stringify(batch)).not.toContain("prompt");
    expect(JSON.stringify(batch)).not.toContain("content");
  });

  it("starts a new session after 30 minutes of inactivity", () => {
    const time = clock();
    const analytics = new BrowserAnalytics(baseConfig, time.runtime);

    analytics.track("message_sent");
    time.advance(5 * 60 * 1000);
    analytics.track("message_sent");
    time.advance(31 * 60 * 1000);
    analytics.track("message_sent");

    const day = analytics.buildBatch()?.days[0];
    expect(day?.sessions).toBe(2);
    expect(day?.sessionSeconds).toBe(35 * 60);
    expect(day?.events).toContainEqual({ name: "message_sent", count: 3 });
  });

  it("never exceeds the server's 100-counter batch cardinality", () => {
    const time = clock();
    const analytics = new BrowserAnalytics(baseConfig, time.runtime);

    for (let index = 0; index < 50; index += 1) analytics.track("model_used", `day1-${index}`);
    time.advance(24 * 60 * 60 * 1000);
    for (let index = 0; index < 50; index += 1) analytics.track("model_used", `day2-${index}`);
    time.advance(24 * 60 * 60 * 1000);
    analytics.track("provider_used", "should-not-be-added");

    const batch = analytics.buildBatch();
    const counters = batch?.days.reduce((total, day) => total + day.events.length, 0);
    expect(counters).toBe(100);
    expect(batch?.days.flatMap((day) => day.events)).not.toContainEqual({
      name: "provider_used",
      dimension: "should-not-be-added",
      count: 1,
    });
  });

  it("does not collect outside explicitly configured production origins", () => {
    const time = clock({ origin: "http://localhost:5173" });
    const analytics = new BrowserAnalytics(baseConfig, time.runtime);

    analytics.track("message_sent");

    expect(analytics.enabled).toBe(false);
    expect(analytics.buildBatch()).toBeNull();
  });

  it("normalizes configured origins", () => {
    const time = clock({ origin: "https://example.com" });
    const analytics = new BrowserAnalytics({
      ...baseConfig,
      productionOrigins: ["https://example.com/landing", "https://www.example.com"],
    }, time.runtime);

    expect(analytics.enabled).toBe(true);
  });

  it("uploads with the configured app id and no app secret", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return new Response("{}", { status: 200 });
    };
    const time = clock({ fetch: fetchMock });
    const analytics = new BrowserAnalytics(baseConfig, time.runtime);
    analytics.track("generation_completed");

    await analytics.flush(true);

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(url).toBe(DEFAULT_ANALYTICS_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(headers).toMatchObject({
      "content-type": "application/json",
      "x-app-id": "chat-byok-pro",
    });
    expect(headers?.["x-installation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers).not.toHaveProperty("x-app-key");
    expect(init?.credentials).toBe("omit");
    expect(init?.referrerPolicy).toBe("no-referrer");
  });

  it("uses a separate default storage namespace for every app", () => {
    const storage = new MemoryStorage();
    const first = clock({ storage });
    const second = clock({ storage });
    const appA = new BrowserAnalytics({ ...baseConfig, appId: "app-a" }, first.runtime);
    const appB = new BrowserAnalytics({ ...baseConfig, appId: "app-b" }, second.runtime);

    appA.track("opened");
    appB.track("opened");

    expect(storage.values.has("web-app-foundation.analytics.app-a.v1")).toBe(true);
    expect(storage.values.has("web-app-foundation.analytics.app-b.v1")).toBe(true);
  });

  it("drops malformed dimensions instead of sending malformed payloads", () => {
    const time = clock();
    const analytics = new BrowserAnalytics(baseConfig, time.runtime);
    analytics.track("model_used", "model with spaces");

    expect(analytics.buildBatch()?.days[0]?.events).toContainEqual({ name: "model_used", count: 1 });
  });
});
