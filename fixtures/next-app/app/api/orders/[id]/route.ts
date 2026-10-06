import { getWatchup, withWatchupRoute } from '@watchupltd/nextjs/server';

export const runtime = 'nodejs';

// Reads the id from the URL so the same file type-checks on Next 14
// (params object) and Next 15 (params promise).
export const GET = withWatchupRoute(
  async (req: Request) => {
    const id = new URL(req.url).pathname.split('/').pop() ?? '';
    getWatchup().setUser({ id: `customer-${id}` });
    return Response.json({ id });
  },
  { route: '/api/orders/[id]' },
);
