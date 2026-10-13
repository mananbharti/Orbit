import { Pressable, Text } from 'react-native';
import { Icon } from './Icon';
import { useTheme } from '../theme';

export function BackButton({ onPress, label = 'Agent' }: { onPress: () => void; label?: string }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={14} onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 44, opacity: pressed ? 0.5 : 1, marginLeft: -6 })}>
      <Icon name="back" size={24} color={t.tint} />
      <Text style={{ color: t.tint, fontSize: 17 }}>{label}</Text>
    </Pressable>
  );
}
