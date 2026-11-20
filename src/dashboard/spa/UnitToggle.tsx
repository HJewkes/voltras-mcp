import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { alpha, getSemanticColors, useOnSurfaceColor } from '@titan-design/react-ui';

import { type MassUnit } from './live-page/mass';

// Semantic reads for the toggle's own chrome — its translucent (alpha) overlay
// ground, active-segment plane, and border. These are NOT on-surface text roles, so they come
// from the token map rather than `useOnSurfaceColor`; the toggle's text uses the hook.
const t = getSemanticColors('dark');

const UNITS: readonly MassUnit[] = ['lbs', 'kg'];

// The live page floats the toggle in its corner; the summary page sets it in its header row.
const CORNER: ViewStyle = { position: 'absolute', bottom: 14, right: 18, zIndex: 10 };

/** A subtle segmented control toggling the wall's weight/force display unit (VW-63). */
export function UnitToggle(props: {
  unit: MassUnit;
  onChange: (unit: MassUnit) => void;
  placement?: 'corner' | 'inline';
}) {
  return (
    <View
      style={{
        ...(props.placement === 'inline' ? {} : CORNER),
        flexDirection: 'row',
        borderRadius: 8,
        overflow: 'hidden',
        borderWidth: 1,
        // `border-default` was deleted in titan 0.12.0 — solid dark borders are
        // gone and separation is the alpha hairline family's job now. Same role,
        // and self-normalizing, so it holds up on whatever plane this floats over.
        borderColor: t['hairline-default'],
        backgroundColor: alpha(t['surface-overlay'], 0.85),
      }}
    >
      {UNITS.map((u) => (
        <UnitSegment key={u} unit={u} active={u === props.unit} onPress={props.onChange} />
      ))}
    </View>
  );
}

function UnitSegment(props: {
  unit: MassUnit;
  active: boolean;
  onPress: (unit: MassUnit) => void;
}) {
  const activeText = useOnSurfaceColor('primary');
  // Secondary, not tertiary: tertiary measures under 4.5:1 on the raised plane (VW-944).
  const inactiveText = useOnSurfaceColor('secondary');
  return (
    <Pressable
      onPress={() => props.onPress(props.unit)}
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 5,
        backgroundColor: props.active ? t['surface-raised'] : 'transparent',
      }}
    >
      <Text
        style={{
          color: props.active ? activeText : inactiveText,
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 1.5,
        }}
      >
        {props.unit.toUpperCase()}
      </Text>
    </Pressable>
  );
}
