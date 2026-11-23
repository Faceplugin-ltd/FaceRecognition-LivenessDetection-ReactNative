import { useEffect, useState, type ReactNode } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { colors, radius } from '../theme';
import Icon, { type IconName } from './Icon';

/** Rounded status pill (Match / No match, Success / Failed, Pass / Fail …). */
export function Pill({ text, color }: { text: string; color: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: color }]}>
      <Text style={styles.pillText} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/** "ID 12" / count tag. */
export function Tag({
  text,
  style,
}: {
  text: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.tag, style]}>
      <Text style={styles.tagText} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/** Surface card: 16 dp corners, outline. */
export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Metric({ value, label }: { value: string; label: string }) {
  return (
    <Card style={styles.metric}>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.metricLabel} numberOfLines={1}>
        {label}
      </Text>
    </Card>
  );
}

export function MetricsRow({
  items,
}: {
  items: { value: string; label: string }[];
}) {
  return (
    <View style={styles.metricsRow}>
      {items.map((m) => (
        <Metric key={m.label} value={m.value} label={m.label} />
      ))}
    </View>
  );
}

/** Thin bar; [value] 0..1. */
export function ScoreBar({
  value,
  color = colors.primary,
  style,
}: {
  value: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <View style={[styles.barTrack, style]}>
      <View
        style={[
          styles.barFill,
          { width: `${pct * 100}%`, backgroundColor: color },
        ]}
      />
    </View>
  );
}

export function SectionLabel({
  text,
  style,
}: {
  text: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style}>
      <Text style={styles.sectionLabel}>{text}</Text>
    </View>
  );
}

export type Badge = { text: string; color: string };

/** Titled card of label / value rows (Android Sections.add). Title in caps, primary color. */
export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      {children}
    </Card>
  );
}

/** One label · value row with an optional badge pill and score bar (Android Sections.row). */
export function AttrRow({
  label,
  value,
  badge,
  score,
  collapsed,
  onPress,
}: {
  label: string;
  value: string;
  badge?: Badge | null;
  score?: number | null;
  collapsed?: boolean;
  onPress?: () => void;
}) {
  const [open, setOpen] = useState(!collapsed);
  const body = (
    <View style={styles.attrRow}>
      <View style={styles.attrLine}>
        <Text style={styles.attrLabel}>{label}</Text>
        <Text
          style={styles.attrValue}
          numberOfLines={open ? undefined : 2}
          selectable={!collapsed}
        >
          {value}
        </Text>
        {badge ? <Pill text={badge.text} color={badge.color} /> : null}
      </View>
      {score != null && Number.isFinite(score) ? (
        <ScoreBar
          value={score}
          color={badge?.color ?? colors.primary}
          style={styles.attrBar}
        />
      ) : null}
    </View>
  );
  if (collapsed) {
    return <Pressable onPress={() => setOpen((o) => !o)}>{body}</Pressable>;
  }
  if (onPress) return <Pressable onPress={onPress}>{body}</Pressable>;
  return body;
}

export function Button({
  title,
  onPress,
  variant = 'filled',
  color = colors.primary,
  disabled,
  style,
  icon,
}: {
  title: string;
  onPress: () => void;
  variant?: 'filled' | 'outlined' | 'text' | 'tonal';
  color?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: IconName;
}) {
  const filled = variant === 'filled';
  const tonal = variant === 'tonal';
  const bg = filled ? color : tonal ? colors.secondaryContainer : 'transparent';
  const fg = filled
    ? colors.onPrimary
    : tonal
      ? colors.onSecondaryContainer
      : color;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.75}
      style={[
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.45 : 1 },
        variant === 'outlined' && { borderWidth: 1, borderColor: color },
        variant === 'text' && styles.textButton,
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={18} color={fg} /> : null}
      <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
    </TouchableOpacity>
  );
}

export function IconButton({
  name,
  onPress,
  color = colors.onSurfaceVariant,
  size = 24,
  label,
  style,
}: {
  name: IconName;
  onPress: () => void;
  color?: string;
  size?: number;
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.iconButton, style]}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
    >
      <Icon name={name} size={size} color={color} />
    </TouchableOpacity>
  );
}

/** Toolbar with back arrow (pushed screens). */
export function Toolbar({
  title,
  subtitle,
  onBack,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
}) {
  return (
    <View style={styles.toolbar}>
      <IconButton
        name="back"
        onPress={onBack}
        color={colors.onSurface}
        label="Back"
      />
      <View style={styles.toolbarText}>
        <Text style={styles.toolbarTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.toolbarSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  autoFocus,
  style,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  error?: string | null;
  autoFocus?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.field, style]}>
      <Text style={[styles.fieldLabel, error ? { color: colors.error } : null]}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.outline}
        autoFocus={autoFocus}
        style={[
          styles.fieldInput,
          error ? { borderColor: colors.error } : null,
        ]}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

/** Image from a file URI; falls back to a person glyph when missing or unreadable. */
export function Thumb({
  uri,
  size,
  round,
  style,
  onMissing,
  fallbackUri,
}: {
  uri?: string | null;
  size: number;
  round?: boolean;
  style?: StyleProp<ViewStyle>;
  onMissing?: () => void;
  fallbackUri?: string | null;
}) {
  const [src, setSrc] = useState(uri || fallbackUri || null);
  useEffect(() => {
    setSrc(uri || fallbackUri || null);
    if (!uri && !fallbackUri) onMissing?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, fallbackUri]);
  const shape = {
    width: size,
    height: size,
    borderRadius: round ? size / 2 : 12,
  };
  return (
    <View style={[styles.thumb, shape, style]}>
      {src ? (
        <Image
          source={{ uri: src }}
          style={shape}
          resizeMode="cover"
          onError={() => {
            if (src === uri && fallbackUri && fallbackUri !== uri) {
              setSrc(fallbackUri);
            } else {
              setSrc(null);
              onMissing?.();
            }
          }}
        />
      ) : (
        <Icon name="person" size={size * 0.6} color={colors.outline} />
      )}
    </View>
  );
}

/**
 * Shows a region of an image without writing a file: square around the box ([scale] × the
 * longer box side, like the Android Probe tile) or the padded box.
 */
export function CropView({
  uri,
  imgW,
  imgH,
  box,
  size,
  scale = 1.8,
  padding,
  round,
  style,
}: {
  uri: string;
  imgW: number;
  imgH: number;
  box: { x1: number; y1: number; x2: number; y2: number };
  size: number;
  scale?: number;
  /** When set, crops box + padding (fraction of the shorter side) instead of a square. */
  padding?: number;
  round?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  let left: number;
  let top: number;
  let w: number;
  let h: number;
  if (padding != null) {
    const bw = box.x2 - box.x1;
    const bh = box.y2 - box.y1;
    const pad = Math.max(4, Math.min(bw, bh) * padding);
    left = Math.max(0, box.x1 - pad);
    top = Math.max(0, box.y1 - pad);
    w = Math.min(imgW, box.x2 + pad) - left;
    h = Math.min(imgH, box.y2 + pad) - top;
    // keep the tile square: grow the short side around the centre
    const side = Math.min(Math.max(w, h), Math.min(imgW, imgH));
    left = Math.min(Math.max(0, left + w / 2 - side / 2), imgW - side);
    top = Math.min(Math.max(0, top + h / 2 - side / 2), imgH - side);
    w = side;
    h = side;
  } else {
    const side = Math.min(
      Math.round(Math.max(box.x2 - box.x1, box.y2 - box.y1) * scale),
      Math.min(imgW, imgH)
    );
    const cx = (box.x1 + box.x2) / 2;
    const cy = (box.y1 + box.y2) / 2;
    left = Math.min(Math.max(0, cx - side / 2), imgW - side);
    top = Math.min(Math.max(0, cy - side / 2), imgH - side);
    w = side;
    h = side;
  }
  const k = w > 0 ? size / w : 1;
  return (
    <View
      style={[
        {
          width: size,
          height: (h * size) / Math.max(1, w),
          overflow: 'hidden',
        },
        {
          borderRadius: round ? size / 2 : 12,
          backgroundColor: colors.surfaceVariant,
        },
        style,
      ]}
    >
      <Image
        source={{ uri }}
        style={{
          position: 'absolute',
          width: imgW * k,
          height: imgH * k,
          left: -left * k,
          top: -top * k,
        }}
      />
    </View>
  );
}

export type DialogAction = {
  label: string;
  onPress: () => void;
  color?: string;
};

/** Material-style alert dialog that can hold any content (the status card, form fields…). */
export function AppDialog({
  visible,
  title,
  message,
  children,
  actions,
  onDismiss,
}: {
  visible: boolean;
  title?: string;
  message?: string | null;
  children?: ReactNode;
  actions: DialogAction[];
  onDismiss: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <Pressable style={styles.scrim} onPress={onDismiss}>
        <Pressable style={styles.dialog} onPress={() => {}}>
          <ScrollView
            contentContainerStyle={styles.dialogBody}
            keyboardShouldPersistTaps="handled"
          >
            {title ? <Text style={styles.dialogTitle}>{title}</Text> : null}
            {message ? (
              <Text style={styles.dialogMessage}>{message}</Text>
            ) : null}
            {children}
          </ScrollView>
          <View style={styles.dialogActions}>
            {actions.map((a) => (
              <Button
                key={a.label}
                title={a.label}
                variant="text"
                color={a.color ?? colors.primary}
                onPress={a.onPress}
              />
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  pillText: { color: colors.white, fontSize: 12, fontWeight: '600' },
  tag: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: colors.secondaryContainer,
    alignSelf: 'center',
  },
  tagText: {
    color: colors.onSecondaryContainer,
    fontSize: 12,
    fontWeight: '600',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
  },
  metricsRow: { flexDirection: 'row', gap: 8 },
  metric: { flex: 1, paddingVertical: 10, paddingHorizontal: 12 },
  metricValue: { fontSize: 20, fontWeight: '600', color: colors.onSurface },
  metricLabel: { fontSize: 12, color: colors.onSurfaceVariant, marginTop: 2 },
  barTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceVariant,
    overflow: 'hidden',
  },
  barFill: { height: 4, borderRadius: 2 },
  sectionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.primary,
    marginBottom: 8,
  },
  section: { padding: 16, marginTop: 12 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: colors.primary,
    marginBottom: 4,
  },
  attrRow: { paddingVertical: 8 },
  attrLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  attrLabel: { width: 112, fontSize: 14, color: colors.onSurfaceVariant },
  attrValue: { flex: 1, fontSize: 14, color: colors.onSurface },
  attrBar: { marginTop: 6, marginLeft: 120 },
  button: {
    minHeight: 40,
    borderRadius: 20,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  textButton: { paddingHorizontal: 12 },
  buttonText: { fontSize: 14, fontWeight: '600' },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbar: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    backgroundColor: colors.surface,
  },
  toolbarText: { flex: 1, marginLeft: 8 },
  toolbarTitle: { fontSize: 20, color: colors.onSurface },
  toolbarSubtitle: { fontSize: 13, color: colors.onSurfaceVariant },
  field: { marginTop: 12 },
  fieldLabel: { fontSize: 12, color: colors.onSurfaceVariant, marginBottom: 4 },
  fieldInput: {
    borderWidth: 1,
    borderColor: colors.outline,
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.onSurface,
    backgroundColor: colors.surface,
  },
  fieldError: { color: colors.error, fontSize: 12, marginTop: 4 },
  thumb: {
    backgroundColor: colors.surfaceVariant,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: {
    backgroundColor: colors.surfaceContainer,
    borderRadius: 28,
    // The enrolment status is a report, not a prompt: it opens at the size it will need so
    // the steps do not start inside a short box the reader has to grow by scrolling.
    height: '92%',
    overflow: 'hidden',
  },
  dialogBody: { padding: 24, paddingBottom: 8 },
  dialogTitle: { fontSize: 22, color: colors.onSurface, marginBottom: 12 },
  dialogMessage: {
    fontSize: 15,
    color: colors.onSurfaceVariant,
    marginBottom: 12,
    lineHeight: 21,
  },
  dialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
});
