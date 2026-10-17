/** Draws any phone screen with fake data: `?screen=tasks&theme=dark`. Layout, colours and spacing can be checked in a browser before any real phone is involved. Blur, haptics, camera and microphone are NOT real here. */
import { View } from 'react-native';
import { ThemeProvider, useTheme, type ThemePref } from '../src/theme';
import { ActivityScreen } from '../src/screens/ActivityScreen';
import { AppsScreen } from '../src/screens/AppsScreen';
import { ClipboardScreen } from '../src/screens/ClipboardScreen';
import { ControlScreen } from '../src/screens/ControlScreen';
import { FilesScreen } from '../src/screens/FilesScreen';
import { MemoryScreen } from '../src/screens/MemoryScreen';
import { PairScreen } from '../src/screens/PairScreen';
import { RemoteScreen } from '../src/screens/RemoteScreen';
import { PresentScreen } from '../src/screens/PresentScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { DevicesScreen } from '../src/screens/DevicesScreen';
import { ComputersScreen } from '../src/screens/ComputersScreen';
import { AutomationsScreen } from '../src/screens/AutomationsScreen';
import { TerminalScreen } from '../src/screens/TerminalScreen';
import { TabsScreen } from '../src/screens/TabsScreen';
import { TaskDetailScreen } from '../src/screens/TaskDetailScreen';
import { TasksScreen } from '../src/screens/TasksScreen';
import { mockAgent, mockAutomation, mockSceneOptions, mockTerminal, terminalLines, mockTabs, mockClipboard, mockComputers, mockDevices, mockDictation, ipadDeviceId, mockFiles, mockInput, mockInputMacros, mockLauncher, mockLauncherPinned, mockLauncherScenes, mockMemory, mockStore, tasks , mockSystem } from './mocks';

const noop = (): void => {};
export const SCREENS = ['tasks', 'tasks-empty', 'tasks-offline', 'tasks-wake', 'task-detail', 'activity', 'apps', 'apps-pinned', 'apps-scenes', 'clipboard', 'files', 'memory', 'remote', 'remote-macros', 'present', 'control', 'settings', 'devices', 'devices-limited', 'computers', 'computers-switching', 'automations', 'automations-edit', 'terminal', 'terminal-start', 'files-backup', 'tabs', 'pair'] as const;

function Screen({ name }: { name: string }) {
  switch (name) {
    case 'tasks-empty': return <TasksScreen store={mockStore('connected', [])} api={mockAgent()} dictation={mockDictation} name="Manan's PC" onOpen={noop} onRepair={noop} onActivity={noop} onApps={noop} onClipboard={noop} onFiles={noop} onRemote={noop} onPresent={noop} onMemory={noop} onControl={noop} onSettings={noop} />;
    case 'tasks-wake': return <TasksScreen store={mockStore('reconnecting')} api={mockAgent()} dictation={mockDictation} name="Manan's PC" macAddresses={['a1:b2:c3:d4:e5:f6']} wakePreview onOpen={noop} onRepair={noop} onActivity={noop} onApps={noop} onClipboard={noop} onFiles={noop} onRemote={noop} onPresent={noop} onMemory={noop} onControl={noop} onSettings={noop} />;
    case 'tasks-offline': return <TasksScreen store={mockStore('reconnecting')} api={mockAgent()} dictation={mockDictation} name="Manan's PC" onOpen={noop} onRepair={noop} onActivity={noop} onApps={noop} onClipboard={noop} onFiles={noop} onRemote={noop} onPresent={noop} onMemory={noop} onControl={noop} onSettings={noop} />;
    case 'task-detail': return <TaskDetailScreen store={mockStore()} taskId={tasks[0]!.taskId} onBack={noop} />;
    case 'activity': return <ActivityScreen api={mockAgent()} onBack={noop} />;
    case 'apps': return <AppsScreen api={mockLauncherScenes()} onBack={noop} desktopServiceId="pc-1" />;
    case 'apps-pinned': return <AppsScreen api={mockLauncherPinned()} onBack={noop} />;
    case 'apps-scenes': return <AppsScreen api={mockLauncherScenes()} onBack={noop} />;
    case 'clipboard': return <ClipboardScreen api={mockClipboard()} onBack={noop} />;
    case 'files': return <FilesScreen api={mockFiles()} onBack={noop} />;
    case 'files-backup': return <FilesScreen api={mockFiles()} onBack={noop} backup={{ available: true, enabled: true, progress: { done: 3, total: 12, running: true }, onToggle: noop }} />;
    case 'tabs': return <TabsScreen api={mockTabs} onBack={noop} />;
    case 'memory': return <MemoryScreen api={mockMemory()} onBack={noop} />;
    case 'remote': return <RemoteScreen api={mockInput()} onBack={noop} />;
    case 'remote-macros': return <RemoteScreen api={mockInputMacros()} onBack={noop} />;
    case 'present': return <PresentScreen api={mockInputMacros()} onBack={noop} />;
    case 'control': return <ControlScreen api={mockSystem} onBack={noop} onPanic={noop} />;
    case 'settings': return <SettingsScreen name="Manan's PC" onBack={noop} onRepair={noop} autoSync={true} onAutoSync={noop} appLock={true} onAppLock={noop} biometrics={true} onDevices={noop} onComputers={noop} />;
    case 'terminal': return <TerminalScreen api={mockTerminal} onBack={noop} initialState={{ cwd: 'C:\\Users\\Manan', lines: terminalLines }} />;
    case 'terminal-start': return <TerminalScreen api={mockTerminal} onBack={noop} />;
    case 'automations': return <AutomationsScreen api={mockAutomation} scenes={mockSceneOptions} onBack={noop} />;
    case 'automations-edit': return <AutomationsScreen api={mockAutomation} scenes={mockSceneOptions} onBack={noop} initialDraft={{ id: 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa', time: '09:00', days: [1, 2, 3, 4, 5], action: { type: 'scene', sceneId: 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb' } }} />;
    case 'computers': return <ComputersScreen list={mockComputers} activeId={mockComputers[0]!.desktopServiceId} onSwitch={noop} onAdd={noop} onForget={noop} onBack={noop} />;
    case 'computers-switching': return <ComputersScreen list={mockComputers} activeId={mockComputers[0]!.desktopServiceId} switchingId={mockComputers[1]!.desktopServiceId} onSwitch={noop} onAdd={noop} onForget={noop} onBack={noop} />;
    case 'devices': return <DevicesScreen api={mockDevices} onBack={noop} />;
    case 'devices-limited': return <DevicesScreen api={mockDevices} onBack={noop} initialSelected={ipadDeviceId} />;
    case 'pair': return <PairScreen onScanned={async () => {}} />;
    default: return <TasksScreen store={mockStore()} api={mockAgent()} dictation={mockDictation} name="Manan's PC" onOpen={noop} onRepair={noop} onActivity={noop} onApps={noop} onClipboard={noop} onFiles={noop} onRemote={noop} onPresent={noop} onMemory={noop} onControl={noop} onSettings={noop} onComputers={noop} onAutomations={noop} onTerminal={noop} />;
  }
}
function Frame({ screen }: { screen: string }) {
  const t = useTheme();
  return <View style={{ flex: 1, alignItems: 'center', backgroundColor: '#888' }}><View style={{ width: 390, height: 844, backgroundColor: t.bg, overflow: 'hidden' }}><Screen name={screen} /></View></View>;
}
export function Preview() {
  const q = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const theme = (q.get('theme') === 'dark' ? 'dark' : 'light') as ThemePref;
  return <ThemeProvider forcePref={theme}><Frame screen={q.get('screen') ?? 'tasks'} /></ThemeProvider>;
}
