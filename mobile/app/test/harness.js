/*
 * Node require shims for app render tests: react-native maps to react-native-web (already a
 * devDependency for the web preview), native-only expo modules and the connection-bound
 * orbit/storage modules become inert stubs. No new dependencies.
 */
const path = require('path');
const Module = require('module');
const React = require('react');
const origLoad = Module._load;
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
  if (request === 'expo-audio') return { AudioQuality: { HIGH: 'high' }, IOSOutputFormat: { LINEARPCM: 'lpcm' }, requestRecordingPermissionsAsync: async () => ({ granted: true }),
    setAudioModeAsync: async () => {}, useAudioRecorder: () => ({ prepareToRecordAsync: async () => {}, record: () => {}, stop: async () => {}, uri: null }) };
  if (request === 'expo-file-system') return { File: class {} };
  if (request === 'expo-secure-store') return { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} };
  if (request === 'react-native-svg') return { __esModule: true, default: stubComponent(), Path: stubComponent(), Circle: stubComponent(), Rect: stubComponent() };
  if (/(^|[/\\])\.\.[/\\]orbit$/.test(request)) return { friendlyError: e => (e && e.message) || String(e) };
  return origLoad.call(this, request, parent, isMain);
};
