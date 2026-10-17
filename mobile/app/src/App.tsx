import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { connect, forget, pair, type Connected } from './orbit';
import { ActivityScreen } from './screens/ActivityScreen';
import { MemoryScreen } from './screens/MemoryScreen';
import { AppsScreen } from './screens/AppsScreen';
import { ClipboardScreen } from './screens/ClipboardScreen';
import { ControlScreen } from './screens/ControlScreen';
import { FilesScreen } from './screens/FilesScreen';
import { RemoteScreen } from './screens/RemoteScreen';
import { PresentScreen } from './screens/PresentScreen';
import { PairScreen } from './screens/PairScreen';
import { TaskDetailScreen } from './screens/TaskDetailScreen';
import { TasksScreen } from './screens/TasksScreen';
import { loadAppLock, loadClipboardAuto, loadPaired, saveAppLock, saveClipboardAuto } from './storage';
import { authenticate, biometricAvailable } from './biometrics';
import { startClipboardAutoSync, type AutoSync } from './clipboard-auto';
import { ScreenTransition } from './components/ScreenTransition';
import { SettingsScreen } from './screens/SettingsScreen';
import { ThemeProvider, useTheme } from './theme';

export function App() {
  return <ThemeProvider><Shell /></ThemeProvider>;
}

function Shell() {
  const t = useTheme();
  const [settings, setSettings] = useState(false);
  const [booting, setBooting] = useState(true);
  const [locked, setLocked] = useState(false);
  const [appLock, setAppLock] = useState(true);
  const [biometrics, setBiometrics] = useState(false);
  const pendingPaired = useRef<Parameters<typeof connect>[0] | undefined>(undefined);
  const [connected, setConnected] = useState<Connected>();
  const [open, setOpen] = useState<string>();
  const [activity, setActivity] = useState(false);
  const [apps, setApps] = useState(false);
  const [clip, setClip] = useState(false);
  const [control, setControl] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [remote, setRemote] = useState(false);
  const [present, setPresent] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [banner, setBanner] = useState<string>();
  const autoRef = useRef<AutoSync | undefined>(undefined);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showBanner = useCallback((msg: string) => {
    setBanner(msg); clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setBanner(undefined), 2600);
  }, []);

  useEffect(() => {
    void loadClipboardAuto().then(setAutoSync);
    void loadAppLock().then(setAppLock);
    void biometricAvailable().then(setBiometrics);
    void loadPaired().then(async paired => {
      if (!paired) return;
      if (await loadAppLock() && !(await authenticate('Unlock Orbit to connect to your computer'))) {
        pendingPaired.current = paired; setLocked(true); return;
      }
      setConnected(connect(paired));
    }).finally(() => setBooting(false));
  }, []);
  useEffect(() => {
    if (!connected) return;
    const handle = startClipboardAutoSync(connected.clipboard, text => {
      if (autoRef.current) showBanner('Clipboard copied from ' + connected.paired.displayName);
    });
    handle.setEnabled(autoSync);
    autoRef.current = handle;
    return () => { handle.stop(); autoRef.current = undefined; };
  }, [connected, showBanner]);
  useEffect(() => { autoRef.current?.setEnabled(autoSync); }, [autoSync]);
  const onAutoSync = useCallback((on: boolean) => { setAutoSync(on); void saveClipboardAuto(on); }, []);
  useEffect(() => () => { connected?.store.dispose(); connected?.clipboard.dispose(); connected?.files.dispose(); connected?.input.dispose(); connected?.session.stop(); }, [connected]);

  const onScanned = useCallback(async (text: string) => {
    const paired = await pair(text);
    if (appLock && !(await authenticate('Confirm it is you to pair this computer'))) {
      pendingPaired.current = paired; setLocked(true); return;
    }
    setConnected(connect(paired));
  }, [appLock]);
  const unlock = useCallback(async () => {
    if (await authenticate('Unlock Orbit to connect to your computer')) {
      setLocked(false);
      if (pendingPaired.current) { setConnected(connect(pendingPaired.current)); pendingPaired.current = undefined; }
    }
  }, []);
  const repair = useCallback(() => { void forget(connected).then(() => { setConnected(undefined); setOpen(undefined); }); }, [connected]);

  let body;
  if (booting) body = <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator /></View>;
  else if (locked) body = (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>Orbit is locked</Text>
      <Text style={{ color: t.sub, fontSize: 15, textAlign: 'center', paddingHorizontal: 40 }}>Confirm it is you to connect to your computer.</Text>
      <Pressable accessibilityRole="button" onPress={() => { void unlock(); }} style={{ backgroundColor: t.tint, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 28 }}>
        <Text style={{ color: '#FFFFFF', fontSize: 17, fontWeight: '600' }}>Unlock</Text>
      </Pressable>
    </View>
  );
  else if (!connected) body = <PairScreen onScanned={onScanned} />;
  else if (settings) body = <SettingsScreen name={connected.paired.displayName} onBack={() => setSettings(false)} onRepair={repair} autoSync={autoSync} onAutoSync={onAutoSync} appLock={appLock} onAppLock={(on: boolean) => { setAppLock(on); void saveAppLock(on); }} biometrics={biometrics} />;
  else if (memoryOpen) body = <MemoryScreen api={connected.memory} onBack={() => setMemoryOpen(false)} />;
  else if (present) body = <PresentScreen api={connected.input} onBack={() => setPresent(false)} />;
  else if (remote) body = <RemoteScreen api={connected.input} onBack={() => setRemote(false)} />;
  else if (filesOpen) body = <FilesScreen api={connected.files} onBack={() => setFilesOpen(false)} />;
  else if (clip) body = <ClipboardScreen api={connected.clipboard} onBack={() => setClip(false)} />;
  else if (control) body = <ControlScreen api={connected.system} onBack={() => setControl(false)} onPanic={() => { void forget(connected).then(() => { setConnected(undefined); setControl(false); }); }} />;
  else if (apps) body = <AppsScreen api={connected.launcher} onBack={() => setApps(false)} />;
  else if (activity) body = <ActivityScreen api={connected.api} onBack={() => setActivity(false)} />;
  else if (open) body = <TaskDetailScreen store={connected.store} taskId={open} onBack={() => setOpen(undefined)} />;
  else body = <TasksScreen store={connected.store} api={connected.api} dictation={connected.dictation} name={connected.paired.displayName} macAddresses={connected.paired.macAddresses} onOpen={t => setOpen(t.taskId)} onRepair={repair} onActivity={() => setActivity(true)} onApps={() => setApps(true)} onClipboard={() => setClip(true)} onFiles={() => setFilesOpen(true)} onRemote={() => setRemote(true)} onPresent={() => setPresent(true)} onMemory={() => setMemoryOpen(true)} onControl={() => setControl(true)} onSettings={() => setSettings(true)} />;
  const screenKey = booting ? 'boot' : !connected ? 'pair' : settings ? 'settings' : control ? 'control' : present ? 'present' : memoryOpen ? 'memory' : remote ? 'remote' : filesOpen ? 'files' : clip ? 'clip' : apps ? 'apps' : activity ? 'activity' : open ? `task-${open}` : 'tasks';
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScreenTransition key={screenKey}>{body}</ScreenTransition>
      {banner ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 60, left: 24, right: 24, alignItems: 'center' }}>
          <View style={{ backgroundColor: t.card, borderRadius: 980, paddingVertical: 10, paddingHorizontal: 20, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{banner}</Text>
          </View>
        </View>
      ) : null}
      <StatusBar style={t.isDark ? 'light' : 'dark'} />
    </View>
  );
}
