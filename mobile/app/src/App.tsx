import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { connect, forget, pair, type Connected } from './orbit';
import { ActivityScreen } from './screens/ActivityScreen';
import { AppsScreen } from './screens/AppsScreen';
import { PairScreen } from './screens/PairScreen';
import { TaskDetailScreen } from './screens/TaskDetailScreen';
import { TasksScreen } from './screens/TasksScreen';
import { loadPaired } from './storage';

export function App() {
  const [booting, setBooting] = useState(true);
  const [connected, setConnected] = useState<Connected>();
  const [open, setOpen] = useState<string>();
  const [activity, setActivity] = useState(false);
  const [apps, setApps] = useState(false);

  useEffect(() => {
    void loadPaired().then(paired => { if (paired) setConnected(connect(paired)); }).finally(() => setBooting(false));
  }, []);
  useEffect(() => () => { connected?.store.dispose(); connected?.session.stop(); }, [connected]);

  const onScanned = useCallback(async (text: string) => {
    const paired = await pair(text);
    setConnected(connect(paired));
  }, []);
  const repair = useCallback(() => { void forget(connected).then(() => { setConnected(undefined); setOpen(undefined); }); }, [connected]);

  let body;
  if (booting) body = <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator /></View>;
  else if (!connected) body = <PairScreen onScanned={onScanned} />;
  else if (apps) body = <AppsScreen api={connected.launcher} onBack={() => setApps(false)} />;
  else if (activity) body = <ActivityScreen api={connected.api} onBack={() => setActivity(false)} />;
  else if (open) body = <TaskDetailScreen store={connected.store} taskId={open} onBack={() => setOpen(undefined)} />;
  else body = <TasksScreen store={connected.store} api={connected.api} name={connected.paired.displayName} onOpen={t => setOpen(t.taskId)} onRepair={repair} onActivity={() => setActivity(true)} onApps={() => setApps(true)} />;
  return <>{body}<StatusBar style="auto" /></>;
}
