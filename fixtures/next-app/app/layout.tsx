import type { ReactNode } from 'react';
import { WatchupProvider } from '@watchupltd/nextjs/client';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WatchupProvider apiKey={process.env.NEXT_PUBLIC_WATCHUP_API_KEY}>{children}</WatchupProvider>
      </body>
    </html>
  );
}
