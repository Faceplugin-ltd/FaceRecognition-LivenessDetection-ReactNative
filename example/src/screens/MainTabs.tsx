import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { S } from '../strings';
import { colors } from '../theme';
import Icon, { type IconName } from '../ui/Icon';
import CameraTab from './CameraTab';
import PeopleTab from './PeopleTab';
import SettingsTab from './SettingsTab';
import LivenessTab from './LivenessTab';

type TabKey = 'identify' | 'people' | 'attribute' | 'liveness' | 'settings';

const TABS: { key: TabKey; label: string; icon: IconName }[] = [
  { key: 'identify', label: S.tab_identify, icon: 'identity' },
  { key: 'people', label: S.tab_people, icon: 'people' },
  { key: 'attribute', label: S.tab_attribute, icon: 'attribute' },
  { key: 'liveness', label: S.tab_liveness, icon: 'liveness' },
  { key: 'settings', label: S.tab_settings, icon: 'settings' },
];

/**
 * Bottom tabs (Android MainActivity): Identity · People · Attribute · Liveness · Settings.
 * Visited tabs stay mounted (hidden), like fragment hide / show; only the shown camera tab
 * keeps its camera active.
 */
export default function MainTabs() {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const [tab, setTab] = useState<TabKey>('identify');
  const [visited, setVisited] = useState<Set<TabKey>>(
    () => new Set<TabKey>(['identify'])
  );

  const select = (k: TabKey) => {
    setTab(k);
    setVisited((v) => (v.has(k) ? v : new Set(v).add(k)));
  };

  const page = (k: TabKey) => {
    if (!visited.has(k)) return null;
    const shown = tab === k;
    let content;
    switch (k) {
      case 'identify':
        content = <CameraTab mode="identify" active={shown && focused} />;
        break;
      case 'attribute':
        content = <CameraTab mode="attribute" active={shown && focused} />;
        break;
      case 'people':
        content = <PeopleTab />;
        break;
      case 'liveness':
        content = <LivenessTab active={shown && focused} />;
        break;
      case 'settings':
        content = <SettingsTab visible={shown} />;
        break;
    }
    return (
      <View key={k} style={[styles.page, !shown && styles.hidden]}>
        {content}
      </View>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.pages}>{TABS.map((t) => page(t.key))}</View>
      <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <Pressable
              key={t.key}
              style={styles.item}
              onPress={() => select(t.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={t.label}
            >
              <View style={[styles.indicator, on && styles.indicatorOn]}>
                <Icon
                  name={t.icon}
                  size={22}
                  color={
                    on ? colors.onSecondaryContainer : colors.onSurfaceVariant
                  }
                />
              </View>
              <Text
                style={[styles.label, on && styles.labelOn]}
                numberOfLines={1}
              >
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  pages: { flex: 1 },
  page: { ...StyleSheet.absoluteFillObject },
  hidden: { display: 'none' },
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceContainer,
    paddingTop: 12,
  },
  item: { flex: 1, alignItems: 'center' },
  indicator: {
    width: 56,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicatorOn: { backgroundColor: colors.secondaryContainer },
  label: { fontSize: 12, marginTop: 4, color: colors.onSurfaceVariant },
  labelOn: { color: colors.onSurface, fontWeight: '600' },
});
