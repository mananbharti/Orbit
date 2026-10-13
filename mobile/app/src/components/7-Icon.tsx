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
