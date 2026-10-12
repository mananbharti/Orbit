import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { connect, forget, pair, type Connected } from './orbit';
import { PairScreen } from './screens/PairScreen';
import { TaskDetailScreen } from './screens/TaskDetailScreen';
import { TasksScreen } from './screens/TasksScreen';
import { loadPaired } from './storage';

export function App() {
  const [booting, setBooting] = useState(true);
  const [connected, setConnected] = useState<Connected>();
  const [open, setOpen] = useState<string>();

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
  else if (open) body = <TaskDetailScreen store={connected.store} taskId={open} onBack={() => setOpen(undefined)} />;
  else body = <TasksScreen store={connected.store} name={connected.paired.displayName} onOpen={t => setOpen(t.taskId)} onRepair={repair} />;
  return <>{body}<StatusBar style="auto" /></>;
}
