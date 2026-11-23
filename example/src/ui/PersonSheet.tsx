import { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import * as Gallery from '../data/gallery';
import type { FaceRecord } from '../data/gallery';
import { reportFromJson } from '../data/report';
import { enrolledDateTime, idTag, score } from '../format';
import { S } from '../strings';
import { colors } from '../theme';
import {
  AppDialog,
  Button,
  IconButton,
  ScoreBar,
  Tag,
  TextField,
  Thumb,
} from './components';
import StatusCard from './StatusCard';
import { showToast } from './Toast';

/**
 * Person bottom sheet (Android FaceDetailSheet), opened from a result, the matches list,
 * the attribute page or the People list. [similarity] < 0 hides the Similarity row.
 */
export default function PersonSheet({
  id,
  similarity = -1,
  onClose,
}: {
  id: number | null;
  similarity?: number;
  onClose: () => void;
}) {
  const { width } = useWindowDimensions();
  const [record, setRecord] = useState<FaceRecord | null>(null);
  const [originalMissing, setOriginalMissing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (id == null) return;
    const rec = await Gallery.get(id);
    if (!rec) {
      showToast(S.face_not_found);
      onClose();
      return;
    }
    setRecord(rec);
  }, [id, onClose]);

  useEffect(() => {
    setRecord(null);
    setOriginalMissing(false);
    if (id != null) load();
  }, [id, load]);

  const visible = id != null && record != null;
  const tile = (width - 16 * 2 - 12) / 2;
  const report = record ? reportFromJson(record.enrollReport) : null;

  const doDelete = async () => {
    const r = record;
    setConfirmDelete(false);
    onClose();
    if (!r) return;
    if (await Gallery.remove(r.id)) showToast(S.deleted_face(r.name));
  };

  const startEdit = () => {
    if (!record) return;
    setName(record.name);
    setNote(record.note);
    setNameError(null);
    setEditing(true);
  };

  const saveEdit = async () => {
    const n = name.trim();
    if (!n || !record) {
      setNameError(S.enter_name);
      return;
    }
    setEditing(false);
    await Gallery.update(record.id, n, note.trim());
    load();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        {record ? (
          <ScrollView contentContainerStyle={styles.body}>
            <View style={styles.head}>
              <Text style={styles.title} numberOfLines={2}>
                {record.name}
              </Text>
              <Tag text={idTag(record.id)} />
              <IconButton name="close" onPress={onClose} label={S.txt_close} />
            </View>

            <View style={styles.photos}>
              <View>
                <Thumb uri={record.cropPath} size={tile} />
                <Text style={styles.caption}>{S.face}</Text>
              </View>
              <View>
                <Thumb
                  uri={record.originalPath}
                  size={tile}
                  onMissing={() => setOriginalMissing(true)}
                />
                <Text style={styles.caption}>
                  {originalMissing ? S.original_not_stored : S.original_photo}
                </Text>
              </View>
            </View>

            {similarity >= 0 ? (
              <View style={styles.row}>
                <Text style={styles.label}>{S.similarity}</Text>
                <ScoreBar value={similarity} style={styles.simBar} />
                <Text style={styles.simValue}>{score(similarity)}</Text>
              </View>
            ) : null}

            <View style={styles.row}>
              <Text style={styles.label}>{S.txt_note}</Text>
              <Text style={styles.value}>{record.note || S.no_note}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>{S.txt_enrolled}</Text>
              <Text style={styles.value}>
                {enrolledDateTime(record.createdAt)}
              </Text>
            </View>

            <View style={styles.status}>
              {report ? (
                <StatusCard report={report} title={S.enroll_status_title} />
              ) : (
                <Text style={styles.noReport}>{S.enroll_no_report}</Text>
              )}
            </View>

            <View style={styles.actions}>
              <Button
                title={S.txt_delete}
                variant="outlined"
                color={colors.danger}
                onPress={() => setConfirmDelete(true)}
                style={styles.action}
              />
              <Button
                title={S.txt_edit}
                onPress={startEdit}
                style={styles.action}
              />
            </View>
          </ScrollView>
        ) : null}
      </View>

      <AppDialog
        visible={confirmDelete}
        message={S.delete_one_confirm}
        onDismiss={() => setConfirmDelete(false)}
        actions={[
          { label: S.cancel, onPress: () => setConfirmDelete(false) },
          { label: S.txt_delete, onPress: doDelete, color: colors.danger },
        ]}
      />
      <AppDialog
        visible={editing}
        title={S.edit_person}
        onDismiss={() => setEditing(false)}
        actions={[
          { label: S.cancel, onPress: () => setEditing(false) },
          { label: S.txt_save, onPress: saveEdit },
        ]}
      >
        <TextField
          label={S.txt_name}
          value={name}
          onChangeText={(t) => {
            setName(t);
            setNameError(null);
          }}
          placeholder={S.name_hint}
          error={nameError}
        />
        <TextField
          label={S.note_optional}
          value={note}
          onChangeText={setNote}
          placeholder={S.note_hint}
        />
      </AppDialog>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    maxHeight: '88%',
    backgroundColor: colors.surfaceContainer,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  handle: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.outline,
    marginTop: 12,
  },
  body: { padding: 16, paddingBottom: 32 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flexShrink: 1, fontSize: 22, color: colors.onSurface },
  photos: { flexDirection: 'row', gap: 12, marginTop: 16 },
  caption: { fontSize: 12, color: colors.onSurfaceVariant, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  label: { width: 96, fontSize: 14, color: colors.onSurfaceVariant },
  value: { flex: 1, fontSize: 15, color: colors.onSurface },
  simBar: { flex: 1, marginRight: 12 },
  simValue: { fontSize: 15, fontWeight: '600', color: colors.onSurface },
  status: { marginTop: 16 },
  noReport: { fontSize: 14, color: colors.onSurfaceVariant },
  actions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  action: { flex: 1 },
});
