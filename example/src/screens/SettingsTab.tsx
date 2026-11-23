import { useEffect, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import type { LicenseStatus } from 'face-recognition-sdk';
import {
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  resetSettings,
  updateSettings,
  useSettings,
} from '../data/settings';
import { licenseStatus, sdkVersion, useEngineState } from '../engine';
import { score } from '../format';
import { S } from '../strings';
import { colors } from '../theme';
import { IconButton, SectionLabel, Tag } from '../ui/components';
import Slider from '../ui/Slider';

// App version of this demo (package.json of the example app).
const APP_VERSION: string = require('../../package.json').version;

function licenseText(s: LicenseStatus): string {
  const parts: string[] = [];
  parts.push(s.label.trim() || (s.licensed ? 'Licensed' : 'Not licensed'));
  if (s.licensed && s.levelName.trim() && s.levelName.toLowerCase() !== 'none')
    parts.push(s.levelName);
  if (s.recognition) parts.push('Recognition');
  if (s.liveness) parts.push('Liveness');
  return S.about_license_fmt(parts.join(' · '));
}

/** Match, liveness and pose thresholds; Reset on the header (Android SettingsFragment). */
export default function SettingsTab({ visible }: { visible: boolean }) {
  const s = useSettings();
  const engine = useEngineState();
  const [license, setLicense] = useState(S.about_license_loading);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    licenseStatus().then((l) => {
      if (!cancelled) setLicense(licenseText(l));
    });
    return () => {
      cancelled = true;
    };
  }, [visible, engine]);

  const unitRow = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void
  ) => (
    <View style={styles.block}>
      <View style={styles.line}>
        <Text style={styles.label}>{label}</Text>
        <Tag text={score(value)} />
      </View>
      <Slider
        value={value}
        min={min}
        max={max}
        step={0.01}
        onChange={onChange}
      />
    </View>
  );

  const angleRow = (
    label: string,
    value: number,
    onChange: (v: number) => void
  ) => (
    <View style={styles.block}>
      <View style={styles.line}>
        <Text style={styles.label}>{label}</Text>
        <Tag text={String(Math.round(value))} />
      </View>
      <Slider value={value} min={0} max={90} step={1} onChange={onChange} />
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>{S.settings}</Text>
        <IconButton
          name="reset"
          onPress={() => resetSettings()}
          label={S.restore_default_settings}
          color={colors.onSurface}
        />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionLabel text={S.matching} />
        {unitRow(
          S.match_threshold,
          s.threshold,
          MIN_THRESHOLD,
          MAX_THRESHOLD,
          (v) => updateSettings({ threshold: v })
        )}
        <Text style={styles.help}>{S.threshold_help}</Text>

        <Pressable
          style={styles.switchRow}
          onPress={() => updateSettings({ liveness: !s.liveness })}
        >
          <View style={styles.switchText}>
            <Text style={styles.label}>{S.liveness_check}</Text>
            <Text style={styles.help}>{S.liveness_help}</Text>
          </View>
          <Switch
            value={s.liveness}
            onValueChange={(v) => {
              updateSettings({ liveness: v });
            }}
            trackColor={{ true: colors.primary, false: colors.surfaceVariant }}
            thumbColor={colors.white}
          />
        </Pressable>

        <Pressable
          style={styles.switchRow}
          onPress={() => updateSettings({ skipReview: !s.skipReview })}
        >
          <View style={styles.switchText}>
            <Text style={styles.label}>{S.skip_review}</Text>
            <Text style={styles.help}>{S.skip_review_help}</Text>
          </View>
          <Switch
            value={s.skipReview}
            onValueChange={(v) => {
              updateSettings({ skipReview: v });
            }}
            trackColor={{ true: colors.primary, false: colors.surfaceVariant }}
            thumbColor={colors.white}
          />
        </Pressable>

        {unitRow(S.liveness_threshold, s.livenessThreshold, 0, 1, (v) =>
          updateSettings({ livenessThreshold: v })
        )}
        {angleRow(S.yaw_threshold, s.yaw, (v) => updateSettings({ yaw: v }))}
        {angleRow(S.roll_threshold, s.roll, (v) => updateSettings({ roll: v }))}
        {angleRow(S.pitch_threshold, s.pitch, (v) =>
          updateSettings({ pitch: v })
        )}

        <View style={styles.divider} />
        <SectionLabel text={S.about} />
        <Text style={styles.info}>{license}</Text>
        <Text
          style={styles.info}
        >{`${S.txt_sdk_version}: ${sdkVersion()}`}</Text>
        <Text
          style={styles.info}
        >{`${S.txt_app_version}: ${APP_VERSION}`}</Text>

        {/* The company mark closes the screen, now that About is no longer a tab. */}
        <Image
          source={require('../assets/fp_logo.png')}
          style={styles.logo}
          resizeMode="contain"
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    height: 56,
  },
  title: { fontSize: 22, color: colors.onSurface },
  logo: { height: 44, alignSelf: 'center', marginTop: 32, marginBottom: 24 },
  content: { padding: 16, paddingBottom: 32 },
  block: { marginTop: 8 },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: { fontSize: 16, color: colors.onSurface },
  help: {
    fontSize: 12,
    color: colors.onSurfaceVariant,
    marginTop: 2,
    lineHeight: 17,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    gap: 12,
  },
  switchText: { flex: 1 },
  divider: {
    height: 1,
    backgroundColor: colors.outlineVariant,
    marginVertical: 20,
  },
  info: { fontSize: 14, color: colors.onSurface, marginTop: 6 },
});
