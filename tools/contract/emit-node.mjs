// Contract workload for @watchupltd/node (uses the built dist/).
import { Watchup } from '../../node/dist/index.mjs';

const watchup = new Watchup({
  apiKey: 'wup_live_test',
  baseUrl: process.env.WATCHUP_BASE_URL,
  environment: 'contract',
  flushInterval: 60_000,
  flagRefreshInterval: 0,
  handleSignals: false,
  shutdownTimeout: 8_000,
});
watchup.setUser({ id: 'contract-user' });
watchup.captureError(new Error('x'.repeat(256_000)), {
  headers: { Authorization: 'Bearer secret-token-123' },
  password: 'hunter2',
});
for (let i = 0; i < 3; i++) watchup.track(`unicode-${i}`, { text: 'é'.repeat(60_000) });
for (let i = 0; i < 150; i++) watchup.startTrace(`contract-trace-${i}`)();
await watchup.flush();
await watchup.shutdown();
