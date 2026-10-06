// Express quick start for @watchupltd/node.
// Run: WATCHUP_API_KEY=wup_live_xxx node examples/node-express.mjs
import express from 'express';
import { Watchup } from '@watchupltd/node';

const watchup = new Watchup({
  apiKey: process.env.WATCHUP_API_KEY,
  baseUrl: process.env.WATCHUP_BASE_URL, // omit in production
  environment: process.env.NODE_ENV,
  release: process.env.GIT_SHA,
  service: 'orders-api',
});

const app = express();
app.use(watchup.requestMiddleware()); // 1. before your routes

app.use((req, _res, next) => {
  // Request-scoped: concurrent requests never share a user.
  const userId = req.header('x-user-id');
  if (userId) watchup.setUser({ id: userId });
  next();
});

app.get('/orders/:id', async (req, res) => {
  const order = await watchup.traceQuery('SELECT * FROM orders WHERE id = $1', async () => ({ id: req.params.id }), {
    system: 'postgresql',
  });
  watchup.track('order.viewed', { orderId: order.id });
  res.json(order);
});

app.get('/fail', () => {
  throw new Error('Something broke');
});

app.use(watchup.errorMiddleware()); // 2. after your routes
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const server = app.listen(Number(process.env.PORT ?? 3000), async () => {
  const { port } = server.address();
  // Demo traffic, then a graceful shutdown that flushes everything.
  await fetch(`http://127.0.0.1:${port}/orders/42`, { headers: { 'x-user-id': 'user-1' } });
  await fetch(`http://127.0.0.1:${port}/fail`);
  server.close();
  await watchup.shutdown();
});
