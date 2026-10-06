# @watchupltd/nextjs

Official Watchup SDK for **Next.js 14 and 15** (App Router and Pages Router): a client provider with router-based page views, a server singleton, route wrappers and instrumentation hooks.

## Install

```bash
npm install @watchupltd/nextjs @watchupltd/browser @watchupltd/react @watchupltd/node
```

```bash
# .env.local
NEXT_PUBLIC_WATCHUP_API_KEY=wup_pub_xxx   # public key: browser
WATCHUP_API_KEY=wup_live_xxx              # secret key: server only — never NEXT_PUBLIC_
```

## Client (App Router)

```tsx
// app/layout.tsx
import { WatchupProvider } from '@watchupltd/nextjs/client';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WatchupProvider apiKey={process.env.NEXT_PUBLIC_WATCHUP_API_KEY}>{children}</WatchupProvider>
      </body>
    </html>
  );
}
```

Page views come from `usePathname()`/`useSearchParams()` (inside a Suspense boundary, so static pages still prerender). All `@watchupltd/react` hooks are re-exported from `@watchupltd/nextjs/client`.

## Server

```ts
// instrumentation.ts
import { registerWatchup } from '@watchupltd/nextjs/server';

export function register() {
  registerWatchup({ release: process.env.GIT_SHA }); // Node.js runtime only; reads WATCHUP_API_KEY
}

// Next.js 15: report Server Component, Route Handler and Server Action errors.
export { captureRequestError as onRequestError } from '@watchupltd/nextjs/server';
```

On Next.js 14, enable `experimental.instrumentationHook` in `next.config.js` (or call `initWatchup()` in your server code).

```ts
// app/api/orders/[id]/route.ts
import { getWatchup, withWatchupRoute } from '@watchupltd/nextjs/server';

export const GET = withWatchupRoute(async (req: Request) => {
  getWatchup().setUser({ id: 'customer-1' }); // scoped to this request
  return Response.json({ ok: true });
}, { route: '/api/orders/[id]' });
```

```ts
// pages/api/hello.ts (Pages Router)
import { withWatchupApi } from '@watchupltd/nextjs/server';

export default withWatchupApi(async (req, res) => res.json({ hello: 'world' }), { route: '/api/hello' });
```

The wrappers record one trace with the real status code, report an error once and re-throw it unchanged, and ignore `notFound()`/`redirect()`. `@watchupltd/nextjs/server` runs on the **Node.js runtime only** and throws a clear error on Edge.

Without `WATCHUP_API_KEY` the server SDK is a no-op (with one warning); without a public key the client provider is a no-op.

## Links

- [Next.js SDK docs](https://watchup.site/docs/sdks/nextjs) · [Changelog](./CHANGELOG.md) · [Fixture app](../fixtures/next-app)

## License

MIT © Watchup Ltd
