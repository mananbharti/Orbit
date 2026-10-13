import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { connect, forget, pair, type Connected } from './orbit';
import { ActivityScreen } from './screens/ActivityScreen';
import { MemoryScreen } from './screens/MemoryScreen';
import { AppsScreen } from './screens/AppsScreen';
import { ClipboardScreen } from './screens/ClipboardScreen';
import { FilesScreen } from './screens/FilesScreen';
import { RemoteScreen } from './screens/RemoteScreen';
import { PairScreen } from './screens/PairScreen';
import { TaskDetailScreen } from './screens/TaskDetailScreen';
import { TasksScreen } from './screens/TasksScreen';
import { loadPaired } from './storage';
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
  const [connected, setConnected] = useState<Connected>();
  const [open, setOpen] = useState<string>();
  const [activity, setActivity] = useState(false);
  const [apps, setApps] = useState(false);
  const [clip, setClip] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [remote, setRemote] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  useEffect(() => {
    void loadPaired().then(paired => { if (paired) setConnected(connect(paired)); }).finally(() => setBooting(false));
  }, []);
  useEffect(() => () => { connected?.store.dispose(); connected?.clipboard.dispose(); connected?.files.dispose(); connected?.input.dispose(); connected?.session.stop(); }, [connected]);

  const onScanned = useCallback(async (text: string) => {
    const paired = await pair(text);
    setConnected(connect(paired));
  }, []);
  const repair = useCallback(() => { void forget(connected).then(() => { setConnected(undefined); setOpen(undefined); }); }, [connected]);

  let body;
  if (booting) body = <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator /></View>;
  else if (!connected) body = <PairScreen onScanned={onScanned} />;
  else if (settings) body = <SettingsScreen name={connected.paired.displayName} onBack={() => setSettings(false)} onRepair={repair} />;
  else if (memoryOpen) body = <MemoryScreen api={connected.memory} onBack={() => setMemoryOpen(false)} />;
  else if (remote) body = <RemoteScreen api={connected.input} onBack={() => setRemote(false)} />;
  else if (filesOpen) body = <FilesScreen api={connected.files} onBack={() => setFilesOpen(false)} />;
  else if (clip) body = <ClipboardScreen api={connected.clipboard} onBack={() => setClip(false)} />;
  else if (apps) body = <AppsScreen api={connected.launcher} onBack={() => setApps(false)} />;
  else if (activity) body = <ActivityScreen api={connected.api} onBack={() => setActivity(false)} />;
  else if (open) body = <TaskDetailScreen store={connected.store} taskId={open} onBack={() => setOpen(undefined)} />;
  else body = <TasksScreen store={connected.store} api={connected.api} dictation={connected.dictation} name={connected.paired.displayName} onOpen={t => setOpen(t.taskId)} onRepair={repair} onActivity={() => setActivity(true)} onApps={() => setApps(true)} onClipboard={() => setClip(true)} onFiles={() => setFilesOpen(true)} onRemote={() => setRemote(true)} onMemory={() => setMemoryOpen(true)} onSettings={() => setSettings(true)} />;
  const screenKey = booting ? 'boot' : !connected ? 'pair' : settings ? 'settings' : memoryOpen ? 'memory' : remote ? 'remote' : filesOpen ? 'files' : clip ? 'clip' : apps ? 'apps' : activity ? 'activity' : open ? `task-${open}` : 'tasks';
  return <View style={{ flex: 1, backgroundColor: t.bg }}><ScreenTransition key={screenKey}>{body}</ScreenTransition><StatusBar style={t.isDark ? 'light' : 'dark'} /></View>;
}
