export const SESSION_DURATION_MS = 20 * 60 * 1000;
export const CHECKIN_PRINT_WINDOW_MS = 60 * 60 * 1000;

const DB_NAME = 'uniattend_db';
const DB_VERSION = 2; // bumped for level index and multi-session support
const STUDENTS_STORE = 'students';
const CHECKINS_STORE = 'checkIns';
const META_STORE = 'meta';
const SESSIONS_KEY = 'active_sessions';
const ADMIN_PRINT_KEY = 'admin_print_pin';

export interface ActiveSession {
  id: string;
  courseTitle: string;
  courseCode: string;
  lecturerName: string;
  pin: string;
  location?: {
    latitude: number;
    longitude: number;
    accuracy: number;
    radiusMeters: number;
  };
  startedAt: string;
  expiresAt: string;
}

export interface AdminPrintAccess {
  pin: string;
  generatedAt: string;
  expiresAt: string;
}

export interface RegisteredStudent {
  id: string;
  name: string;
  regNumber: string;
  faculty: string;
  department: string;
  level: string;
  faceImage: string | null;
  faceDescriptor?: number[];
  registeredAt: string;
}

export interface AttendanceCheckIn {
  id: string;
  sessionId: string;
  courseTitle: string;
  courseCode?: string;
  lecturerName?: string;
  sessionStartedAt?: string;
  printedAt?: string;
  regNumber: string;
  name: string;
  faculty: string;
  department: string;
  level: string;
  checkedInAt: string;
}

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeRegNumber(value: string) {
  return normalizeWhitespace(value).toUpperCase();
}

export function normalizeAcademicText(value: string) {
  return normalizeWhitespace(value.replace(/([a-z])([A-Z])/g, '$1 $2'))
    .toLowerCase()
    .replace(/\b\w/g, char => char.toUpperCase());
}

export function normalizeLevel(value: string) {
  const cleaned = normalizeWhitespace(value).toUpperCase();
  const digits = cleaned.match(/\d{3}/)?.[0];
  if (digits) return `${digits}L`;
  return cleaned;
}

export function normalizeStudentRecord<T extends Pick<RegisteredStudent, 'regNumber' | 'faculty' | 'department' | 'level'>>(student: T): T {
  return {
    ...student,
    regNumber: normalizeRegNumber(student.regNumber),
    faculty: normalizeAcademicText(student.faculty),
    department: normalizeAcademicText(student.department),
    level: normalizeLevel(student.level),
  };
}

interface MetaRecord<T> {
  key: string;
  value: T;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function closeAllConnections(): Promise<void> {
  if (!dbPromise) return Promise.resolve();
  try {
    return dbPromise.then(db => db.close()).catch(() => {}).finally(() => {
      dbPromise = null;
    });
  } catch { /* ignore */ }
  return Promise.resolve();
}

async function openDb(): Promise<IDBDatabase> {
  await closeAllConnections();

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result as IDBDatabase;

      if (!db.objectStoreNames.contains(STUDENTS_STORE)) {
        const students = db.createObjectStore(STUDENTS_STORE, { keyPath: 'id' });
        students.createIndex('regNumber', 'regNumber', { unique: true });
        students.createIndex('faculty', 'faculty', { unique: false });
        students.createIndex('department', 'department', { unique: false });
        students.createIndex('level', 'level', { unique: false });
      } else {
        const storeNames = db.objectStoreNames;
        if (storeNames.contains(STUDENTS_STORE)) {
          const students = db.transaction(STUDENTS_STORE, 'readwrite').objectStore(STUDENTS_STORE);
          if (!students.indexNames.contains('level')) {
            students.createIndex('level', 'level', { unique: false });
          }
        }
      }

      if (!db.objectStoreNames.contains(CHECKINS_STORE)) {
        const checkIns = db.createObjectStore(CHECKINS_STORE, { keyPath: 'id' });
        checkIns.createIndex('sessionId', 'sessionId', { unique: false });
        checkIns.createIndex('courseTitle', 'courseTitle', { unique: false });
        checkIns.createIndex('regNumber', 'regNumber', { unique: false });
        checkIns.createIndex('level', 'level', { unique: false });
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open database'));
    request.onblocked = () => {
      // Silently retry after a short delay instead of rejecting
      setTimeout(() => {
        const retryRequest = indexedDB.open(DB_NAME, DB_VERSION);
        retryRequest.onsuccess = () => resolve(retryRequest.result);
        retryRequest.onerror = () => reject(retryRequest.error || new Error('Failed to open database'));
      }, 500);
    };
  });
}

async function store<T>(name: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    const request = action(transaction.objectStore(name));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getMeta<T>(key: string) {
  const record = await store<MetaRecord<T> | undefined>(META_STORE, 'readonly', objectStore => objectStore.get(key));
  return record?.value ?? null;
}

function setMeta<T>(key: string, value: T) {
  return store<IDBValidKey>(META_STORE, 'readwrite', objectStore => objectStore.put({ key, value }));
}

function deleteMeta(key: string) {
  return store<undefined>(META_STORE, 'readwrite', objectStore => objectStore.delete(key));
}

export function generatePin() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

// ── Active Sessions (supports multiple simultaneous sessions) ──

export async function readActiveSessions(): Promise<ActiveSession[]> {
  const sessions = await getMeta<ActiveSession[]>(SESSIONS_KEY);
  if (!sessions) return [];
  const now = Date.now();
  // Clean up expired sessions
  const valid = sessions.filter(s => s.pin && s.courseTitle && new Date(s.expiresAt).getTime() > now);
  if (valid.length !== sessions.length) {
    // Persist cleaned list
    setMeta(SESSIONS_KEY, valid).catch(() => {});
  }
  return valid;
}

export async function readActiveSession(): Promise<ActiveSession | null> {
  const sessions = await readActiveSessions();
  return sessions.length > 0 ? sessions[0] : null;
}

export function saveActiveSession(session: ActiveSession) {
  return setMeta(SESSIONS_KEY, [session]);
}

export function saveActiveSessions(sessions: ActiveSession[]) {
  return setMeta(SESSIONS_KEY, sessions);
}

export function clearActiveSession() {
  return deleteMeta(SESSIONS_KEY);
}

export function clearActiveSessions() {
  return deleteMeta(SESSIONS_KEY);
}

// ── Admin Print Access ──

export async function readAdminPrintAccess(): Promise<AdminPrintAccess | null> {
  const access = await getMeta<AdminPrintAccess>(ADMIN_PRINT_KEY);
  if (!access) return null;
  if (!access.pin || new Date(access.expiresAt).getTime() <= Date.now()) {
    await clearAdminPrintAccess();
    return null;
  }
  return access;
}

export function saveAdminPrintAccess(access: AdminPrintAccess) {
  return setMeta(ADMIN_PRINT_KEY, access);
}

export function clearAdminPrintAccess() {
  return deleteMeta(ADMIN_PRINT_KEY);
}

// ── Students ──

export async function readStudents(): Promise<RegisteredStudent[]> {
  const students = await store<RegisteredStudent[]>(STUDENTS_STORE, 'readonly', objectStore => objectStore.getAll());
  return students.map(normalizeStudentRecord).sort((a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime());
}

export async function readStudentsByLevel(level: string): Promise<RegisteredStudent[]> {
  const students = await store<RegisteredStudent[]>(STUDENTS_STORE, 'readonly', objectStore => {
    const index = objectStore.index('level');
    return index.getAll(level);
  });
  return students.sort((a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime());
}

export function saveStudent(student: RegisteredStudent) {
  return store<IDBValidKey>(STUDENTS_STORE, 'readwrite', objectStore => objectStore.put(normalizeStudentRecord(student)));
}

export function deleteStudent(id: string) {
  return store<undefined>(STUDENTS_STORE, 'readwrite', objectStore => objectStore.delete(id));
}

// ── Check-ins ──

async function readAllCheckIns(): Promise<AttendanceCheckIn[]> {
  const checkIns = await store<AttendanceCheckIn[]>(CHECKINS_STORE, 'readonly', objectStore => objectStore.getAll());
  return checkIns.sort((a, b) => new Date(b.checkedInAt).getTime() - new Date(a.checkedInAt).getTime());
}

function getCheckInListAge(checkIn: AttendanceCheckIn) {
  return Date.now() - new Date(checkIn.sessionStartedAt || checkIn.checkedInAt).getTime();
}

async function deleteExpiredUnprintedCheckIns(checkIns: AttendanceCheckIn[]) {
  const expired = checkIns.filter(item => !item.printedAt && getCheckInListAge(item) > CHECKIN_PRINT_WINDOW_MS);
  if (expired.length === 0) return checkIns;

  await Promise.all(expired.map(item =>
    store<undefined>(CHECKINS_STORE, 'readwrite', objectStore => objectStore.delete(item.id))
  ));

  const expiredIds = new Set(expired.map(item => item.id));
  return checkIns.filter(item => !expiredIds.has(item.id));
}

export async function readCheckIns(): Promise<AttendanceCheckIn[]> {
  const checkIns = await readAllCheckIns();
  return deleteExpiredUnprintedCheckIns(checkIns);
}

export async function readCheckInsBySession(sessionId: string): Promise<AttendanceCheckIn[]> {
  const all = await readCheckIns();
  return all.filter(c => c.sessionId === sessionId);
}

export async function saveCheckIn(checkIn: AttendanceCheckIn) {
  // Prevent duplicate check-in for same session + regNumber
  const existing = await store<AttendanceCheckIn[]>(CHECKINS_STORE, 'readonly', objectStore => {
    const index = objectStore.index('sessionId');
    return index.getAll(checkIn.sessionId);
  });
  const duplicate = existing.find(item =>
    item.regNumber.toLowerCase() === checkIn.regNumber.toLowerCase()
  );

  if (duplicate) {
    await store<undefined>(CHECKINS_STORE, 'readwrite', objectStore => objectStore.delete(duplicate.id));
  }

  return store<IDBValidKey>(CHECKINS_STORE, 'readwrite', objectStore => objectStore.put(checkIn));
}

export async function markCheckInsPrinted(sessionId: string) {
  const existing = await store<AttendanceCheckIn[]>(CHECKINS_STORE, 'readonly', objectStore => {
    const index = objectStore.index('sessionId');
    return index.getAll(sessionId);
  });

  const printedAt = new Date().toISOString();
  await Promise.all(existing.map(item =>
    store<IDBValidKey>(CHECKINS_STORE, 'readwrite', objectStore => objectStore.put({ ...item, printedAt }))
  ));
}

export async function deleteCheckIn(id: string, sessionId?: string) {
  const existing = await store<AttendanceCheckIn | undefined>(CHECKINS_STORE, 'readonly', objectStore => objectStore.get(id));
  if (!existing) return;
  if (sessionId && existing.sessionId !== sessionId) return;
  return store<undefined>(CHECKINS_STORE, 'readwrite', objectStore => objectStore.delete(id));
}
