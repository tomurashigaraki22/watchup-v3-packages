'use client';

import { useFlag, useTrack } from '@watchupltd/nextjs/client';

export function TrackButton() {
  const track = useTrack();
  const beta = useFlag('beta');
  return <button onClick={() => track('fixture.clicked', { beta })}>Track</button>;
}
