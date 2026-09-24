// The only files allowed to call `SqliteSessionStore.open` directly (VW-532).
//
// Every other test opens its store through `src/store/__tests__/open-test-store.ts`, so the
// suite names no engine. The tests below do name one on purpose: they exercise the SQLite
// migration chain itself, which has no meaning under another engine. The helper is here
// because it is the one place the constructor is still called for everyone else.
//
// `eslint.config.mjs` exempts these paths from the guard, and
// `scripts/codemod-open-test-store.mjs` skips them. An entry that no longer calls the
// constructor is a hole, so review it the way the other exemption lists are reviewed.

export const STORE_CONSTRUCTOR_ALLOW_LIST = [
  'src/store/__tests__/open-test-store.ts',
  'src/store/__tests__/sqlite-store-assignment-unique-migration.test.ts',
  'src/store/__tests__/sqlite-store-set-effort-migration.test.ts',
  'src/store/__tests__/sqlite-store-ui-action-device-migration.test.ts',
  'src/store/__tests__/sqlite-store-commitments-migration.test.ts',
  'src/store/__tests__/sqlite-store-prescription-migration.test.ts',
  'src/store/__tests__/sqlite-store-schema-version-range.test.ts',
  'src/store/__tests__/sqlite-store-v7-migration.test.ts',
  'src/store/__tests__/sqlite-store-v14-migration.test.ts',
  'src/store/__tests__/sqlite-store-v16-migration.test.ts',
  'src/store/__tests__/sqlite-store-v17-migration.test.ts',
  'src/store/__tests__/sqlite-store-v18-migration.test.ts',
  'src/store/__tests__/sqlite-store-v20-migration.test.ts',
  'src/store/__tests__/sqlite-store-v21-migration.test.ts',
  'src/store/__tests__/sqlite-store-v22-migration.test.ts',
  'src/store/__tests__/sqlite-store-v23-migration.test.ts',
  'src/store/__tests__/sqlite-store-v24-migration.test.ts',
  'src/store/__tests__/sqlite-store-v25-migration.test.ts',
  'src/store/__tests__/sqlite-store-v26-migration.test.ts',
  'src/store/__tests__/sqlite-store-v27-migration.test.ts',
  'src/store/__tests__/sqlite-store-v28-migration.test.ts',
  'src/store/__tests__/sqlite-store-v29-migration.test.ts',
  'src/store/__tests__/sqlite-store-v30-migration.test.ts',
  'src/store/__tests__/sqlite-store-v31-migration.test.ts',
  'src/store/__tests__/sqlite-store-v32-migration.test.ts',
  'src/store/__tests__/sqlite-store-v33-migration.test.ts',
  'src/store/__tests__/sqlite-store-v34-migration.test.ts',
  'src/store/__tests__/sqlite-store-v35-migration.test.ts',
];
