import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { pickFolderImages } from 'face-recognition-sdk';
import { launchImageLibrary } from 'react-native-image-picker';
import * as Gallery from '../data/gallery';
import type { FaceRecord } from '../data/gallery';
import { enrolledDate, idTag } from '../format';
import type { ImportItem, RootStackParamList } from '../navigation';
import { S } from '../strings';
import { colors } from '../theme';
import { AppDialog, IconButton, Tag, Thumb } from '../ui/components';
import Icon from '../ui/Icon';
import PersonSheet from '../ui/PersonSheet';
import { showToast } from '../ui/Toast';

const PAGE_SIZE = 30;

/**
 * People (Android PeopleFragment): count tag, Add (one person / multiple photos), Delete all,
 * search (name or note, 250 ms debounce), paged list newest first, person sheet on tap.
 * Bulk enroll: select photos or a folder, matching Android/iOS.
 */
export default function PeopleTab() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [items, setItems] = useState<FaceRecord[]>([]);
  const [all, setAll] = useState(0);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirmAll, setConfirmAll] = useState<number | null>(null);
  const [sheetId, setSheetId] = useState<number | null>(null);
  const gen = useRef(0);
  const endReached = useRef(false);
  const loadingRef = useRef(false);
  const itemsRef = useRef<FaceRecord[]>([]);

  const loadMore = useCallback(async (q: string, g: number) => {
    if (loadingRef.current || endReached.current) return;
    loadingRef.current = true;
    setLoading(true);
    const pg = await Gallery.page(q, PAGE_SIZE, itemsRef.current.length);
    if (g !== gen.current) return;
    loadingRef.current = false;
    setLoading(false);
    if (pg.length < PAGE_SIZE) endReached.current = true;
    itemsRef.current = [...itemsRef.current, ...pg];
    setItems(itemsRef.current);
  }, []);

  const reload = useCallback(
    async (q: string) => {
      const g = ++gen.current;
      itemsRef.current = [];
      setItems([]);
      endReached.current = false;
      loadingRef.current = false;
      const [a, f] = await Promise.all([Gallery.count(), Gallery.count(q)]);
      if (g !== gen.current) return;
      setAll(a);
      setTotal(f);
      loadMore(q, g);
    },
    [loadMore]
  );

  // 250 ms search debounce
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    reload(query);
    return Gallery.subscribe(() => reload(query));
  }, [query, reload]);

  const pickPhotos = async () => {
    const res = await launchImageLibrary({
      mediaType: 'photo',
      selectionLimit: 0,
    });
    const picked: ImportItem[] = (res.assets ?? [])
      .filter((a) => !!a.uri)
      .map((a) => ({
        uri: a.uri!,
        fileName: a.fileName ?? a.uri!.split('/').pop() ?? 'photo',
      }));
    if (picked.length) navigation.navigate('Import', { items: picked });
  };

  const pickFolder = async () => {
    const picked = await pickFolderImages();
    if (picked.length) navigation.navigate('Import', { items: picked });
  };

  const chooseMultipleSource = () => {
    setMenu(false);
    Alert.alert(S.add_multiple, undefined, [
      { text: S.cancel, style: 'cancel' },
      { text: S.select_photos, onPress: () => void pickPhotos() },
      { text: S.select_folder, onPress: () => void pickFolder() },
    ]);
  };

  const askDeleteAll = async () => {
    const n = await Gallery.count();
    if (n === 0) {
      showToast(S.nothing_to_delete);
      return;
    }
    setConfirmAll(n);
  };

  const deleteAll = async () => {
    setConfirmAll(null);
    const n = await Gallery.removeAll();
    showToast(S.deleted_all(n));
  };

  const showEmpty =
    items.length === 0 && !loading && (all === 0 || total === 0);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>{S.people}</Text>
        <Tag text={String(all)} style={styles.count} />
        <View style={styles.flex} />
        <IconButton
          name="add"
          onPress={() => setMenu(true)}
          label={S.txt_add_person}
          color={colors.onSurface}
        />
        <IconButton
          name="delete"
          onPress={askDeleteAll}
          label={S.delete_all_faces}
          color={colors.onSurface}
        />
      </View>

      <View style={styles.search}>
        <Icon name="search" size={20} color={colors.onSurfaceVariant} />
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={S.search_hint}
          placeholderTextColor={colors.onSurfaceVariant}
          style={styles.searchInput}
          returnKeyType="search"
        />
      </View>

      {showEmpty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>
            {query ? S.no_results : S.txt_empty_title}
          </Text>
          {query ? null : (
            <Text style={styles.emptyBody}>{S.txt_empty_body}</Text>
          )}
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(r) => String(r.id)}
          onEndReachedThreshold={0.5}
          onEndReached={() => loadMore(query, gen.current)}
          renderItem={({ item }) => {
            const date = enrolledDate(item.createdAt);
            return (
              <Pressable style={styles.row} onPress={() => setSheetId(item.id)}>
                <Thumb uri={item.cropPath} size={48} round />
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {item.note ? `${item.note} · ${date}` : date}
                  </Text>
                </View>
                <Tag text={idTag(item.id)} />
              </Pressable>
            );
          }}
        />
      )}

      <Modal
        visible={menu}
        transparent
        animationType="fade"
        onRequestClose={() => setMenu(false)}
      >
        <Pressable style={styles.menuScrim} onPress={() => setMenu(false)}>
          <View style={styles.menu}>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenu(false);
                navigation.navigate('AddPerson');
              }}
            >
              <Text style={styles.menuText}>{S.add_one_person}</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={chooseMultipleSource}>
              <Text style={styles.menuText}>{S.add_multiple}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <AppDialog
        visible={confirmAll != null}
        title={S.delete_all_faces}
        message={S.delete_all_confirm(confirmAll ?? 0)}
        onDismiss={() => setConfirmAll(null)}
        actions={[
          { label: S.cancel, onPress: () => setConfirmAll(null) },
          { label: S.delete_all, onPress: deleteAll, color: colors.danger },
        ]}
      />

      <PersonSheet id={sheetId} onClose={() => setSheetId(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 56,
    gap: 4,
  },
  title: { fontSize: 22, color: colors.onSurface },
  count: { marginLeft: 8 },
  flex: { flex: 1 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 14,
    borderRadius: 28,
    backgroundColor: colors.surfaceContainer,
    gap: 8,
  },
  searchInput: { flex: 1, height: 48, fontSize: 16, color: colors.onSurface },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 14,
  },
  rowText: { flex: 1 },
  name: { fontSize: 16, color: colors.onSurface },
  sub: { fontSize: 13, color: colors.onSurfaceVariant, marginTop: 2 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyTitle: { fontSize: 18, color: colors.onSurface, textAlign: 'center' },
  emptyBody: {
    fontSize: 14,
    color: colors.onSurfaceVariant,
    marginTop: 8,
    textAlign: 'center',
  },
  menuScrim: { flex: 1 },
  menu: {
    position: 'absolute',
    top: 96,
    right: 64,
    minWidth: 200,
    backgroundColor: colors.surfaceContainer,
    borderRadius: 4,
    paddingVertical: 8,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  menuItem: { paddingHorizontal: 16, paddingVertical: 14 },
  menuText: { fontSize: 15, color: colors.onSurface },
});
