export type ImportItem = { uri: string; fileName: string };

export type RootStackParamList = {
  /** Logo while the engine activates in the background. */
  Splash: undefined;
  /** Bottom tabs: Identity · People · Attribute · Settings · About. */
  Main: undefined;
  /** Identify result (ResultStore.last). */
  Result: undefined;
  /** "N more ›": every match at/above the threshold (ResultStore.last). */
  Matches: undefined;
  /** Attribute result (ResultStore.attribute). */
  AttributeResult: undefined;
  /** Capture coach + Enroll with name / note. */
  AddPerson: undefined;
  /** Import picked photos, one person per photo. */
  Import: { items: ImportItem[] };
};
