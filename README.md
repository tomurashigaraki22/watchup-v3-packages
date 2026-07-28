# watchup-v3-packages

Official SDK monorepo for [Watchup](https://watchup.site) — application monitoring, error capture, request tracing, and custom event tracking.

## Framework auto setup

Use the setup CLI from an existing project:

```bash
npx create-watchup@latest
npx create-watchup@latest next --api-key wup_pub_xxx
npx create-watchup@latest express --api-key wup_live_xxx
```

The CLI detects Next.js, React/Vite, Node.js, and Express projects, installs the matching WatchUp SDK package, adds environment keys, and creates the setup files needed for errors, traces, page views, and live logs.

## Packages

| Package | Registry | Description |
|---|---|---|
| [`create-watchup/`](./create-watchup/) | [npm: create-watchup](https://www.npmjs.com/package/create-watchup) | Framework auto-setup CLI |
| [`node/`](./node/) | [npm · @watchupltd/node](https://www.npmjs.com/package/@watchupltd/node) | Express middleware for Node 18+ servers |
| [`browser/`](./browser/) | [npm · @watchupltd/browser](https://www.npmjs.com/package/@watchupltd/browser) | Browser error capture + Web Vitals |
| [`react/`](./react/) | [npm · @watchupltd/react](https://www.npmjs.com/package/@watchupltd/react) | React error boundary + hooks |
| [`nextjs/`](./nextjs/) | [npm · @watchupltd/nextjs](https://www.npmjs.com/package/@watchupltd/nextjs) | Next.js App Router provider + route wrapping |
| [`svelte/`](./svelte/) | [npm · @watchupltd/svelte](https://www.npmjs.com/package/@watchupltd/svelte) | Svelte store + action |
| [`dotnet/`](./dotnet/) | [NuGet · Watchup](https://www.nuget.org/packages/Watchup) | ASP.NET Core middleware + DI extensions |
| [`python/`](./python/) | [PyPI · watchup](https://pypi.org/project/watchup) | Flask, Django, FastAPI, and WSGI middleware |

---

## Quick install

**Node.js / Express**
```bash
npm install @watchupltd/node
```

**Browser**
```bash
npm install @watchupltd/browser
```

**React**
```bash
npm install @watchupltd/react
```

**Next.js**
```bash
npm install @watchupltd/nextjs
```

**Svelte**
```bash
npm install @watchupltd/svelte
```

**.NET**
```bash
dotnet add package Watchup
```

**Python**
```bash
pip install watchup
```

---

## Usage examples

### Node.js / Express

```js
import express from "express";
import { Watchup } from "@watchupltd/node";

const watchup = new Watchup({ apiKey: process.env.WATCHUP_API_KEY });
const app = express();

app.use(watchup.requestMiddleware());
// ... your routes ...
app.use(watchup.errorMiddleware());
```

### Browser

```js
import { Watchup } from "@watchupltd/browser";

const watchup = new Watchup({ apiKey: "wup_live_..." });
watchup.track("page.viewed", { path: window.location.pathname });
```

### React

```jsx
import { WatchupProvider, useWatchup } from "@watchupltd/react";

function App() {
  return (
    <WatchupProvider apiKey="wup_live_...">
      <YourApp />
    </WatchupProvider>
  );
}

function YourComponent() {
  const { track } = useWatchup();
  return <button onClick={() => track("button.clicked")}>Click</button>;
}
```

### Next.js

```tsx
// app/layout.tsx
import { WatchupProvider } from "@watchupltd/nextjs/client";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <WatchupProvider apiKey={process.env.NEXT_PUBLIC_WATCHUP_KEY!}>
          {children}
        </WatchupProvider>
      </body>
    </html>
  );
}
```

### Svelte

```svelte
<script>
  import { WatchupProvider } from "@watchupltd/svelte";
</script>

<WatchupProvider apiKey="wup_live_...">
  <slot />
</WatchupProvider>
```

### Python / Flask

```python
from flask import Flask
from watchup import Watchup

watchup = Watchup(api_key="wup_live_xxxxxxxxxxxx")
app = Flask(__name__)

watchup.init_app(app)   # request tracing + error capture wired automatically
```

### .NET / ASP.NET Core

```csharp
// Program.cs
using Watchup.Middleware;

builder.Services.AddWatchup(o =>
{
    o.ApiKey      = builder.Configuration["Watchup:ApiKey"]!;
    o.Environment = builder.Environment.EnvironmentName;
});

app.UseRouting();
app.UseWatchup();
app.MapControllers();
```

---

## Repository structure

```
watchup-v3-packages/
├── browser/        # @watchupltd/browser
├── dotnet/
│   ├── Watchup/            # NuGet package source
│   └── Watchup.Tests/      # xUnit tests
├── nextjs/         # @watchupltd/nextjs
├── node/           # @watchupltd/node
├── python/         # watchup (PyPI)
├── react/          # @watchupltd/react
└── svelte/         # @watchupltd/svelte
```

Each JS/TS package is independently versioned and published. The `dotnet/` directory is a standard .NET solution.

---

## Documentation & Links

| Resource | URL |
|---|---|
| Website | [watchup.site](https://watchup.site) |
| Full docs | [watchup.site/docs](https://watchup.site/docs) |
| Getting started | [watchup.site/docs/getting-started](https://watchup.site/docs/getting-started) |
| Node.js SDK | [watchup.site/docs/sdks/node](https://watchup.site/docs/sdks/node) |
| Browser SDK | [watchup.site/docs/sdks/browser](https://watchup.site/docs/sdks/browser) |
| React SDK | [watchup.site/docs/sdks/react](https://watchup.site/docs/sdks/react) |
| Next.js SDK | [watchup.site/docs/sdks/nextjs](https://watchup.site/docs/sdks/nextjs) |
| Svelte SDK | [watchup.site/docs/sdks/svelte](https://watchup.site/docs/sdks/svelte) |
| .NET SDK | [watchup.site/docs/sdks/dotnet](https://watchup.site/docs/sdks/dotnet) |
| Go SDK | [watchup.site/docs/sdks/go](https://watchup.site/docs/sdks/go) |
| Python SDK | [watchup.site/docs/sdks/python](https://watchup.site/docs/sdks/python) |
| Pricing | [watchup.site/pricing](https://watchup.site/pricing) |
| Dashboard | [watchup.site/login](https://watchup.site/login) |

## License

MIT
