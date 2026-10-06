import type { NextApiRequest, NextApiResponse } from 'next';
import { withWatchupApi } from '@watchupltd/nextjs/server';

export default withWatchupApi(async (_req: NextApiRequest, res: NextApiResponse) => {
  res.status(200).json({ hello: 'pages router' });
}, { route: '/api/hello' });
