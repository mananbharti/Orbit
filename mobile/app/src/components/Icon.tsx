import Svg, { Path } from 'react-native-svg';

const paths = {
  back: 'M15 18l-6-6 6-6',
  send: 'M12 19V5M5 12l7-7 7 7',
  remote: 'M3 5h18v12H3zM8 21h8M12 17v4',
  files: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  clipboard: 'M9 3h6v3H9zM7 4.5H6a2 2 0 00-2 2V19a2 2 0 002 2h12a2 2 0 002-2V6.5a2 2 0 00-2-2h-1',
  memory: 'M12 3a6 6 0 00-3 11.2V17h6v-2.8A6 6 0 0012 3zM9 21h6',
  apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M6 15v4',
  lock: 'M6 11V8a6 6 0 1 1 12 0v3M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  power: 'M12 3v9M18.36 6.64a9 9 0 1 1-12.72 0',
  speaker: 'M4 9v6h4l5 4V5L8 9H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  mute: 'M4 9v6h4l5 4V5L8 9H4zM22 9l-6 6M16 9l6 6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  control: 'M4 8h10M18 8h2M4 16h2M10 16h10M14 6v4M6 14v4',
  present: 'M3 4h18v11H3zM12 15v3M9 21h6M12 8.5l3.5 2-3.5 2z',
  automations: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 7v5l3.5 2',
} as const;
export type IconName = keyof typeof paths;

/** Clean line icons, drawn as SVG so they stay sharp at any size and follow the text colour. */
export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d={paths[name]} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
