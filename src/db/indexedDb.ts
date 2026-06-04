import type {
  AppSettings,
  EWMASnapshot,
  SessionInput,
  StrengthExerciseTemplate,
  StrengthSession,
} from "../types";

const DB_NAME = "boulder-load-manager";
const DB_VERSION = 2;

const STORE_SESSIONS = "sessions";
const STORE_SETTINGS = "settings";
const STORE_EWMA = "ewma";
const STORE_STRENGTH_TEMPLATES = "strength-templates";
const STORE_STRENGTH_SESSIONS = "strength-sessions";
const SETTINGS_KEY = "app-settings";

let dbPromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORE_EWMA)) {
        db.createObjectStore(STORE_EWMA, { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains(STORE_STRENGTH_TEMPLATES)) {
        db.createObjectStore(STORE_STRENGTH_TEMPLATES, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORE_STRENGTH_SESSIONS)) {
        db.createObjectStore(STORE_STRENGTH_SESSIONS, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function runTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = action(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadSessions(): Promise<SessionInput[]> {
  const rows = await runTransaction<SessionInput[]>(STORE_SESSIONS, "readonly", (store) =>
    store.getAll(),
  );

  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function saveSession(session: SessionInput): Promise<void> {
  await runTransaction<IDBValidKey>(STORE_SESSIONS, "readwrite", (store) => store.put(session));
}

export async function loadSettings(): Promise<AppSettings | undefined> {
  const row = await runTransaction<{ id: string; value: AppSettings } | undefined>(
    STORE_SETTINGS,
    "readonly",
    (store) => store.get(SETTINGS_KEY),
  );

  return row?.value;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await runTransaction<IDBValidKey>(STORE_SETTINGS, "readwrite", (store) =>
    store.put({ id: SETTINGS_KEY, value: settings }),
  );
}

export async function loadEwmaSnapshots(): Promise<EWMASnapshot[]> {
  return runTransaction<EWMASnapshot[]>(STORE_EWMA, "readonly", (store) => store.getAll());
}

export async function saveEwmaSnapshot(snapshot: EWMASnapshot): Promise<void> {
  await runTransaction<IDBValidKey>(STORE_EWMA, "readwrite", (store) => store.put(snapshot));
}

export async function clearSessions(): Promise<void> {
  await runTransaction<undefined>(STORE_SESSIONS, "readwrite", (store) => store.clear());
}

export async function clearEwmaSnapshots(): Promise<void> {
  await runTransaction<undefined>(STORE_EWMA, "readwrite", (store) => store.clear());
}

export async function loadStrengthTemplates(): Promise<StrengthExerciseTemplate[]> {
  const rows = await runTransaction<StrengthExerciseTemplate[]>(STORE_STRENGTH_TEMPLATES, "readonly", (store) =>
    store.getAll(),
  );

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveStrengthTemplate(template: StrengthExerciseTemplate): Promise<void> {
  await runTransaction<IDBValidKey>(STORE_STRENGTH_TEMPLATES, "readwrite", (store) => store.put(template));
}

export async function deleteStrengthTemplate(templateId: string): Promise<void> {
  await runTransaction<undefined>(STORE_STRENGTH_TEMPLATES, "readwrite", (store) => store.delete(templateId));
}

export async function loadStrengthSessions(): Promise<StrengthSession[]> {
  const rows = await runTransaction<StrengthSession[]>(STORE_STRENGTH_SESSIONS, "readonly", (store) =>
    store.getAll(),
  );

  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function saveStrengthSession(session: StrengthSession): Promise<void> {
  await runTransaction<IDBValidKey>(STORE_STRENGTH_SESSIONS, "readwrite", (store) => store.put(session));
}

export async function clearStrengthTemplates(): Promise<void> {
  await runTransaction<undefined>(STORE_STRENGTH_TEMPLATES, "readwrite", (store) => store.clear());
}

export async function clearStrengthSessions(): Promise<void> {
  await runTransaction<undefined>(STORE_STRENGTH_SESSIONS, "readwrite", (store) => store.clear());
}
