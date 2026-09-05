# web-app-foundation

Small reusable browser foundations for lightweight web apps and landing pages.

The first module is a first-party analytics client extracted from `chat.byok.pro`. It keeps the same privacy-oriented model: local cumulative daily snapshots, bounded event counters, session duration, retryable uploads, and no raw activity history.

## Install

Until this package is published to a registry, install it directly from GitHub:

```bash
npm install github:hoangbkit/web-app-foundation
```

## Analytics

```ts
import { createBrowserAnalytics } from "web-app-foundation/analytics";

const analytics = createBrowserAnalytics({
  appId: "my-web-app",
  appVersion: "1.0.0",
  endpoint: "https://analytics.example.com/v1/batch",
  productionOrigins: [
    "https://example.com",
    "https://www.example.com",
  ],
});

analytics.start();
analytics.track("page_view", "pricing");
analytics.track("signup_started");
```

`endpoint` and `productionOrigins` are intentionally required. The library never contains or falls back to a shared analytics server. Analytics is disabled when the current origin is not in `productionOrigins`, so localhost and preview deployments do not send data by default.

### Configuration

| Option | Required | Description |
| --- | --- | --- |
| `appId` | yes | Public application identifier sent as `x-app-id`. |
| `appVersion` | yes | Version string or function returning the current version. |
| `endpoint` | yes | Batch endpoint owned/configured by the host application. |
| `productionOrigins` | yes | Exact production origins allowed to collect analytics. |
| `storageKey` | no | Local storage key. Defaults to an app-specific namespace. |

### Events

Event names must start with a lowercase letter and contain only lowercase letters, numbers, and underscores, up to 48 characters.

Optional dimensions are trimmed, capped at 64 characters, and limited to compact identifier characters. Invalid dimensions are dropped while the event itself is still counted.

```ts
analytics.track("download_clicked", "macos");
analytics.track("theme_changed", "dark");
```

Do not put prompts, messages, email addresses, user-entered text, full URLs, or other personal/content data into event names or dimensions.

### What is sent

Each upload is a cumulative snapshot containing:

- UTC day
- platform (`web`)
- app version
- session count
- active session seconds
- bounded event counters

Requests also include a random installation identifier stored locally in the browser. There is no app secret in the client.

The client retains at most 7 days, 50 distinct event counters per day, and 100 counters per batch. A new session starts after 30 minutes of inactivity. Dirty state is flushed at most once per minute and retried after failures.

### Lifecycle

Call `start()` once after app startup to track sessions/active time and enable periodic flushes. Call `stop()` if the host tears down the analytics instance.

For static landing pages where initial bundle size matters, import the analytics module lazily from your app entry point.

## Development

```bash
npm install
npm run check
```

`npm run check` runs TypeScript checking, tests, and the library build.

## License

MIT
