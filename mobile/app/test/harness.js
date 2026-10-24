/*
 * Node require shims for app render tests: react-native maps to react-native-web (already a
 * devDependency for the web preview), native-only expo modules and the connection-bound
 * orbit/storage modules become inert stubs. No new dependencies.
 */
const path = require('path');
const Module = require('module');
const React = require('react');
const origLoad = Module._load;
// Cached stubs so interaction tests can observe and re-point the same object the component bound to.
const audioStub = { AudioQuality: { HIGH: 'high' }, IOSOutputFormat: { LINEARPCM: 'lpcm' }, requestRecordingPermissionsAsync: async () => ({ granted: true }),
  setAudioModeAsync: async () => {}, useAudioRecorder: () => ({ prepareToRecordAsync: async () => {}, record: () => {}, stop: async () => {}, uri: null }) };
const stubComponent = () => {
  const C = props => React.createElement('svg', null, props && props.children);
  return C;
};
const CORE_DIST = path.join(__dirname, '..', 'dist-test', 'core', 'src', 'index.js');
Module._load = function (request, parent, isMain) {
  if (request === 'react-native') return require('react-native-web');
  if (request === '@orbit/core') return origLoad.call(this, CORE_DIST, parent, isMain);
  if (request === 'expo-haptics') return { selectionAsync: async () => {}, notificationAsync: async () => {}, impactAsync: async () => {},
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }, ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' } };
  if (request === 'expo-audio') return audioStub;
  if (request === 'expo-file-system') {
    // Minimal in-memory File serving one real 16 kHz mono 16-bit WAV (0.25s tone), so wavToPcm16k runs its real parse path.
    const wavBytes = () => {
      const n = 4000; const data = 44 + n * 2; const b = Buffer.alloc(data);
      b.write('RIFF', 0); b.writeUInt32LE(data - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
      b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
      b.write('data', 36); b.writeUInt32LE(n * 2, 40);
      for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 4)), 44 + i * 2);
      return new Uint8Array(b);
    };
    return { File: class { constructor() { this.size = 8044; this.deleted = false; }
      open() { const bytes = wavBytes(); return { offset: 0, readBytes: () => bytes, close: () => {} }; }
      delete() { this.deleted = true; } } };
  }
  if (request === 'expo-secure-store') return { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} };
  if (request === 'react-native-svg') return { __esModule: true, default: stubComponent(), Path: stubComponent(), Circle: stubComponent(), Rect: stubComponent() };
  if (/(^|[/\\])\.\.[/\\]orbit$/.test(request)) return { friendlyError: e => (e && e.message) || String(e) };
  return origLoad.call(this, request, parent, isMain);
};
