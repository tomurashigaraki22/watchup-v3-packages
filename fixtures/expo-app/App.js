import { Text, Pressable } from 'react-native';
import { WatchupProvider, useTrack, useScreen } from '@watchupltd/react-native';

function Home() {
  useScreen('Home');
  const track = useTrack();
  return (
    <Pressable onPress={() => track('fixture.pressed')}>
      <Text>Track</Text>
    </Pressable>
  );
}

export default function App() {
  return (
    <WatchupProvider apiKey={process.env.EXPO_PUBLIC_WATCHUP_API_KEY ?? 'wup_pub_fixture'}>
      <Home />
    </WatchupProvider>
  );
}
