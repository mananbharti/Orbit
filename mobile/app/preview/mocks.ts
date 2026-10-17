/** Fake data and fake APIs so every screen can be drawn without a computer, a phone or a network. Preview only; never imported by the real app. */
import type { AgentApi, AutomationApi, TerminalApi, AppEntry, AuditEntry, ClipboardApi, DevicesApi, DictationApi, FileApi, InputApi, LauncherApi, MemoryApi, SystemApi, TaskEvent, TaskStore, TaskStoreState, TaskSummary } from '@orbit/core';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = 1_760_000_000_000;

export const tasks: TaskSummary[] = [
  { taskId: id(1), state: 'awaiting-approval', createdAt: NOW - 60_000, updatedAt: NOW - 5_000, headline: 'Rename the vacation photos by date and move them into Pictures' },
  { taskId: id(2), state: 'running', createdAt: NOW - 600_000, updatedAt: NOW - 20_000, headline: 'Summarise the three PDFs in Downloads' },
  { taskId: id(3), state: 'completed', createdAt: NOW - 7_200_000, updatedAt: NOW - 7_000_000, headline: 'Find my passport scan' },
  { taskId: id(4), state: 'failed', createdAt: NOW - 9_000_000, updatedAt: NOW - 8_900_000, headline: 'Back up the Documents folder to the external drive, then verify every file was copied correctly' },
  { taskId: id(5), state: 'unknown', createdAt: NOW - 20_000_000, updatedAt: NOW - 19_000_000, headline: 'Clean up the desktop' },
];
const events: TaskEvent[] = [
  { seq: 1, at: NOW - 55_000, kind: 'state', text: 'Started' },
  { seq: 2, at: NOW - 40_000, kind: 'step', text: 'Reading 214 photo names' },
  { seq: 3, at: NOW - 20_000, kind: 'output', text: 'Found 214 photos from 6 trips.' },
  { seq: 4, at: NOW - 5_000, kind: 'approval-request', text: 'Move 214 files into /Pictures/Trips?' },
];
const audit: AuditEntry[] = [
  { at: NOW - 5_000, deviceId: id(9), taskId: id(1), kind: 'approval-requested' },
  { at: NOW - 60_000, deviceId: id(9), taskId: id(1), kind: 'submitted' },
  { at: NOW - 7_000_000, deviceId: id(9), taskId: id(3), kind: 'finished', outcome: 'completed' },
  { at: NOW - 8_900_000, deviceId: id(9), taskId: id(4), kind: 'finished', outcome: 'failed' },
  { at: NOW - 9_000_000, deviceId: id(9), kind: 'paused' },
];
const apps: AppEntry[] = ['Firefox', 'Files', 'Terminal', 'Visual Studio Code', 'Spotify', 'Calculator', 'Settings'].map((name, i) => ({ appId: String(i).repeat(64).slice(0, 64), name }));

const store = <S,>(state: S) => ({ getState: () => state, subscribe: () => () => {} });

export function mockStore(connection: TaskStoreState['connection'] = 'connected', list: TaskSummary[] = tasks): TaskStore {
  const state: TaskStoreState = { connection, tasks: list, needsAttention: list.filter(t => t.state === 'awaiting-approval'), events: { [id(1)]: events } };
  return { ...store(state), refresh: async () => {}, submit: async () => {}, approve: async () => {}, cancel: async () => {}, retry: async () => {}, loadEvents: async () => {} } as unknown as TaskStore;
}
export const mockAgent = (paused = false): AgentApi => ({ audit: async () => audit, safeMode: async () => paused, pause: async () => {}, resume: async () => {} }) as unknown as AgentApi;
export const mockDictation = {} as unknown as DictationApi;
export const mockLauncher = (): LauncherApi => ({ list: async () => apps, launch: async () => {}, getPinned: () => [], scenes: async () => [] }) as unknown as LauncherApi;
/** Two saved scenes, one pinned favourite: the lived-in state. */
export const mockLauncherScenes = (): LauncherApi => ({ list: async () => apps, launch: async () => {}, getPinned: () => [apps[4]!.appId],
  scenes: async () => [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Work', appIds: [apps[3]!.appId, apps[4]!.appId, apps[2]!.appId] },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Chill', appIds: [apps[4]!.appId, apps[0]!.appId] },
  ],
  saveScene: async () => [], deleteScene: async () => [], launchScene: async () => ({ launched: 3, failed: [] }) }) as unknown as LauncherApi;
/** The apps screen with two favourites pinned at the top, as the owner arranged them. */
export const mockLauncherPinned = (): LauncherApi => ({ list: async () => apps, launch: async () => {}, getPinned: () => [apps[4]!.appId, apps[3]!.appId],
  pin: async (id: string) => [id], unpin: async () => [], reorder: async (ids: string[]) => ids }) as unknown as LauncherApi;
export const mockClipboard = (incoming = true): ClipboardApi => ({ ...store({ active: true, ...(incoming ? { incoming: { text: 'Meeting moved to 4pm, room 2B', revision: 3 } } : {}) }),
  history: async () => ({ entries: [
    { id: '11111111-1111-4111-8111-111111111111', text: 'Meeting moved to 4pm, room 2B', at: Date.now() - 4 * 60000, source: 'pc' as const },
    { id: '22222222-2222-4222-8222-222222222222', text: 'https://github.com/mananbharti/Orbit/pull/3', at: Date.now() - 26 * 60000, source: 'phone' as const },
    { id: '33333333-3333-4333-8333-333333333333', text: 'Wi-Fi: Omen_Hotspot / pass: orbit1234', at: Date.now() - 2 * 3600000, source: 'pc' as const },
  ], nextCursor: null }),
  apply: async () => {},
  start: async () => {}, stop: async () => {}, send: async () => 'sent', dismissIncoming: () => {} }) as unknown as ClipboardApi;
export const mockFiles = (transferring = true): FileApi => ({ ...store({ offers: [{ transferId: id(20), direction: 'to-client', name: 'Invoice-October.pdf', sizeBytes: 482_113, sha256: 'a'.repeat(64), chunkBytes: 65536 }],
  ...(transferring ? { transfer: { transferId: id(21), name: 'trip-photos.zip', direction: 'to-desktop', state: 'transferring', doneBytes: 18_000_000, sizeBytes: 42_000_000 } } : {}) }),
  refreshOffers: async () => {}, watch: async () => {}, upload: async () => {}, download: async () => {}, cancel: async () => {}, retry: async () => {} }) as unknown as FileApi;
export const mockMemory = (): MemoryApi => ({ recall: async () => [], remember: async () => '', forget: async () => true }) as unknown as MemoryApi;
export const mockInput = (): InputApi => ({ ...store({ status: 'idle' }), begin: async () => {}, end: async () => {}, push: () => {} }) as unknown as InputApi;
/** Active control session with two saved macros. */
export const mockInputMacros = (): InputApi => ({ ...store({ status: 'active' }), begin: async () => {}, end: async () => {}, push: () => {},
  macros: async () => [
    { id: '33333333-3333-4333-8333-333333333333', name: 'Paste plain', steps: [{ key: 'v', modifiers: ['ctrl', 'shift'] }] },
    { id: '44444444-4444-4444-8444-444444444444', name: 'Task view', steps: [{ key: 'tab', modifiers: ['meta'] }] },
  ],
  saveMacro: async () => [], deleteMacro: async () => [], runMacro: async () => {} }) as unknown as InputApi;
export const mockSystem: SystemApi = ({
  power: async () => {}, panic: async () => 'locked' as const,
  audioSessions: async () => [{ id: '4204', name: 'Spotify', volume: 80, muted: false }, { id: '512', name: 'Discord', volume: 35, muted: true }],
  setAudioSession: async () => {}, getVolume: async () => ({ level: 65, muted: false }), setVolume: async () => {},
  getBrightness: async () => 70, setBrightness: async () => {},
}) as unknown as SystemApi;

const phoneId = '3f9a1c2e-1111-4111-8111-aaaaaaaaaaaa';
const ipadId = '7b2d4e6f-2222-4222-8222-bbbbbbbbbbbb';
export const mockDevices: DevicesApi = { refresh: async () => devices, getDevices: () => devices, currentId: () => phoneId,
  setScopes: async () => devices } as unknown as DevicesApi;
export const devices = [
  { deviceId: phoneId, scopes: 'all' as const },
  { deviceId: ipadId, scopes: ['clipboard', 'files', 'launcher'] as ('clipboard' | 'files' | 'launcher')[] },
];
export const ipadDeviceId = ipadId;

export const mockComputers = [
  { desktopServiceId: 'c1c1c1c1-1111-4111-8111-cccccccccccc', displayName: "Manan's PC", deviceId: '3f9a1c2e-1111-4111-8111-aaaaaaaaaaaa',
    endpoint: 'wss://192.168.137.1:4000/v1/channel', certificateFingerprint: 'a'.repeat(64), credential: 'x'.repeat(43), macAddresses: ['a1:b2:c3:d4:e5:f6'] },
  { desktopServiceId: 'd2d2d2d2-2222-4222-8222-dddddddddddd', displayName: 'Work Laptop', deviceId: '5e7b8c9d-3333-4333-8333-cccccccccccc',
    endpoint: 'wss://192.168.137.20:4000/v1/channel', certificateFingerprint: 'b'.repeat(64), credential: 'y'.repeat(43) },
];

const automationList = [
  { id: 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa', time: '09:00', days: [1, 2, 3, 4, 5], enabled: true,
    action: { type: 'scene', sceneId: 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb' } },
  { id: 'c3c3c3c3-3333-4333-8333-cccccccccccc', time: '23:30', days: [], enabled: true, action: { type: 'power', action: 'sleep' } },
  { id: 'd4d4d4d4-4444-4444-8444-dddddddddddd', time: '18:00', days: [5], enabled: false, action: { type: 'power', action: 'lock' } },
];
export const mockAutomation: AutomationApi = { refresh: async () => automationList, getAutomations: () => automationList,
  save: async () => automationList, setEnabled: async () => automationList, remove: async () => automationList } as unknown as AutomationApi;
export const mockSceneOptions = [{ id: 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb', name: 'Work' }, { id: 'e5e5e5e5-5555-4555-8555-eeeeeeeeeeee', name: 'Gaming' }];

const terminalLines: { id: number; stream: 'cmd' | 'stdout' | 'stderr' | 'note'; text: string }[] = [
  { id: 1, stream: 'note', text: 'Session approved.' },
  { id: 2, stream: 'cmd', text: 'git status' },
  { id: 3, stream: 'stdout', text: 'On branch main' },
  { id: 4, stream: 'stdout', text: 'nothing to commit, working tree clean' },
  { id: 5, stream: 'cmd', text: 'npm run build' },
  { id: 6, stream: 'stderr', text: 'WARN: deprecated option' },
  { id: 7, stream: 'stdout', text: 'Build finished in 4.2s' },
];
export const mockTerminal: TerminalApi = { begin: async () => ({ cwd: 'C:\\Users\\Manan' }),
  exec: async () => ({ exitCode: 0, cwd: 'C:\\Users\\Manan', truncated: false, timedOut: false }),
  interrupt: async () => {}, end: async () => {}, onOutput: () => () => {}, dispose: () => {},
  activeSessionId: 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa' } as unknown as TerminalApi;
export { terminalLines };
