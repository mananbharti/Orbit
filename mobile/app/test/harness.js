// React's act() only flushes queued state updates when this flag is set; without it,
// effects that resolve asynchronously (most screen loads) render after the assertion runs.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
let cachedReactNative;
let cachedClipboard;
let cachedCamera;
Module._load = function (request, parent, isMain) {
  if (request === 'react-native') {
    // react-native-web's VirtualizedList never lets a bare node process exit (solo FlatList mount leaves the
    // event loop alive with no introspectable handle, timer or request; production FileApi is exonerated -
    // a fake api hangs identically). Tests get a faithful minimal list: same props contract, real rows and
    // real press handlers, no DOM virtualization. Everything else stays the real react-native-web module.
    if (!cachedReactNative) {
      const real = require('react-native-web');
      const TestFlatList = props => {
        const header = props.ListHeaderComponent ? (React.isValidElement(props.ListHeaderComponent) ? props.ListHeaderComponent : React.createElement(props.ListHeaderComponent)) : null;
        const rows = (props.data || []).map((item, index) => React.createElement('View', { key: props.keyExtractor ? props.keyExtractor(item, index) : String(index) }, props.renderItem({ item, index })));
        const empty = (!props.data || props.data.length === 0) && props.ListEmptyComponent ? (React.isValidElement(props.ListEmptyComponent) ? props.ListEmptyComponent : React.createElement(props.ListEmptyComponent)) : null;
        return React.createElement('View', { style: [props.style, props.contentContainerStyle] }, header, rows.length ? rows : empty);
      };
      // RNW's TextInput touches the DOM (document is undefined in bare node). The shim is a faithful
      // controlled component: every prop (value, onChangeText, accessibilityLabel, placeholder, maxLength)
      // passes through so tests drive the screen's real state handlers; only the DOM rendering is absent.
      const TestTextInput = props => React.createElement('TextInput', props, props.children);
      cachedReactNative = Object.assign({}, real, { FlatList: TestFlatList, TextInput: TestTextInput });
    }
    return cachedReactNative;
  }
  if (request === '@orbit/core') return origLoad.call(this, CORE_DIST, parent, isMain);
  if (request === 'expo-camera') {
    // Cached so tests re-point the permission and fire real barcode events through the screen's own
    // handler. CameraView is a host element: every prop (onBarcodeScanned, facing, barcode settings)
    // stays observable; only the native preview is absent. The stub request() grants but cannot
    // re-render the screen the way the real hook does - tests assert the request was made, not the re-render.
    if (!cachedCamera) cachedCamera = {
      permission: { granted: false }, requestCalls: 0,
      CameraView: props => React.createElement('CameraView', props, props && props.children),
      useCameraPermissions: () => [cachedCamera.permission, async () => { cachedCamera.requestCalls += 1; cachedCamera.permission = { granted: true }; return { granted: true }; }]
    };
    return cachedCamera;
  }
  if (request === 'expo-haptics') return { selectionAsync: async () => {}, notificationAsync: async () => {}, impactAsync: async () => {},
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }, ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' } };
  if (request === 'expo-audio') return audioStub;
  if (request === 'expo-document-picker') return { getDocumentAsync: async () => ({ canceled: true, assets: [] }) };
  if (request === 'expo-blur') return { BlurView: stubComponent() };
  if (request === 'expo-clipboard') { // Cached so tests observe and re-point the same object the screen bound to.
    if (!cachedClipboard) cachedClipboard = { clipboardText: '', getStringAsync: async () => cachedClipboard.clipboardText, setStringAsync: async t => { cachedClipboard.clipboardText = t; } };
    return cachedClipboard;
  }
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
  if (/(^|[/\\])\.\.[/\\]orbit$/.test(request)) return { friendlyError: e => origLoad.call(this, CORE_DIST, null, false).describeError(e) };
  return origLoad.call(this, request, parent, isMain);
};
