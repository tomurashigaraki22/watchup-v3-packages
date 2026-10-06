// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { WatchupProvider, useFlag, useTrack, useWatchup } from '../src/index.js';

describe('server rendering', () => {
  it('renders without browser globals and hooks are no-ops', () => {
    expect(typeof window).toBe('undefined');
    function Comp() {
      const watchup = useWatchup();
      const track = useTrack();
      track('ssr');
      watchup.captureError(new Error('ssr'));
      return <p>{useFlag('x') ? 'on' : 'off'}</p>;
    }
    const html = renderToString(
      <WatchupProvider apiKey="wup_pub_test">
        <Comp />
      </WatchupProvider>,
    );
    expect(html).toContain('off');
  });
});
