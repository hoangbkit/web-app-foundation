# web-app-foundation

Small reusable browser foundations for lightweight web apps and landing pages.

The first module is a first-party analytics client extracted from `chat.byok.pro`. It keeps the same privacy-oriented model: local cumulative daily snapshots, bounded event/error counters, session duration, retryable uploads, and no raw activity history.

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
  endpoint: "https://analytics.example.com/v1/analytics/batch",
  productionOrigins: [
    "https://example.com",
    "https://www.example.com",
  ],
});

analytics.start();
analytics.track("page_view", "pricing");
analytics.track("signup_started");
analytics.trackError("api_request_failed", "generation");
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


### Errors

Use `trackError` for bounded reliability signals:

```ts
analytics.trackError("model_load_failed", "generation");
analytics.trackError("unexpected_termination", "app", "fatal");
```

Error codes and components must be lowercase snake case, up to 48 characters. Severity is `"error"` or `"fatal"`. Error counters are cumulative per UTC day, just like events.

Do not send exception messages, stack traces, URLs, filenames, prompts, user text, or arbitrary metadata. Map failures to a small stable vocabulary instead.

### What is sent

Each upload is a cumulative snapshot containing:

- UTC day
- platform (`web`)
- app version
- session count
- active session seconds
- bounded event counters
- bounded error counters

Requests also include a random installation identifier stored locally in the browser. There is no app secret in the client, and web snapshots do not send the native-only `osVersion`, `appBuild`, `deviceFamily`, or `architecture` fields.

The client retains at most 7 days, 50 distinct event counters per day, and 100 event counters per batch. One event saturates at 500 occurrences per day, with 2,000 total event occurrences per day. Error analytics allow 20 distinct code/component/severity counters per day, 140 per batch, and 100 total error occurrences per day. A new session starts after 30 minutes of inactivity. Dirty state is flushed at most once per minute and retried after failures.

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
