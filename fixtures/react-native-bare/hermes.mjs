// Compile the Metro bundle with the Hermes compiler shipped in react-native,
// proving the SDK parses under Hermes (no unsupported syntax).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const platformDir = { linux: 'linux64-bin', darwin: 'osx-bin', win32: 'win64-bin' }[process.platform];
const binary = process.platform === 'win32' ? 'hermesc.exe' : 'hermesc';
const hermesc = join('node_modules', 'react-native', 'sdks', 'hermesc', platformDir, binary);
execFileSync(hermesc, ['-emit-binary', '-out', 'out/index.hbc', 'out/index.android.bundle'], { stdio: 'inherit' });
console.log('Hermes compiled the bundle');
