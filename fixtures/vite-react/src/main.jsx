import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WatchupErrorBoundary, WatchupProvider, useFlag, useTrack } from '@watchupltd/react';

function App() {
  const track = useTrack();
  const beta = useFlag('beta');
  return <button onClick={() => track('fixture.clicked', { beta })}>Track</button>;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <WatchupProvider apiKey={import.meta.env.VITE_WATCHUP_API_KEY}>
      <WatchupErrorBoundary fallback={<p>Something went wrong.</p>}>
        <App />
      </WatchupErrorBoundary>
    </WatchupProvider>
  </StrictMode>,
);
