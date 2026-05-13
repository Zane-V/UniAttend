import { NextRequest, NextResponse } from 'next/server';
import { getMongoDb } from '@/lib/mongodb';
import {
  ActiveSession,
  AdminPrintAccess,
  AttendanceCheckIn,
  CHECKIN_PRINT_WINDOW_MS,
  RegisteredStudent,
  normalizeStudentRecord,
} from '@/lib/attendance';

const SESSIONS_KEY = 'active_sessions';
const ADMIN_PRINT_KEY = 'admin_print_pin';

interface MetaRecord<T> {
  key: string;
  value: T;
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function getCheckInListAge(checkIn: AttendanceCheckIn) {
  return Date.now() - new Date(checkIn.sessionStartedAt || checkIn.checkedInAt).getTime();
}

async function getMeta<T>(key: string) {
  const { db } = await getMongoDb();
  const record = await db.collection<MetaRecord<T>>('meta').findOne({ key }, { projection: { _id: 0 } });
  return record?.value ?? null;
}

async function setMeta<T>(key: string, value: T) {
  const { db } = await getMongoDb();
  await db.collection('meta').updateOne({ key }, { $set: { key, value } }, { upsert: true });
}

async function deleteMeta(key: string) {
  const { db } = await getMongoDb();
  await db.collection('meta').deleteOne({ key });
}

async function readActiveSessionsFromMongo() {
  const sessions = await getMeta<ActiveSession[]>(SESSIONS_KEY);
  if (!sessions) return [];

  const now = Date.now();
  const valid = sessions.filter(session =>
    session.pin && session.courseTitle && new Date(session.expiresAt).getTime() > now
  );

  if (valid.length !== sessions.length) {
    await setMeta(SESSIONS_KEY, valid);
  }

  return valid;
}

async function readAdminPrintAccessFromMongo() {
  const access = await getMeta<AdminPrintAccess>(ADMIN_PRINT_KEY);
  if (!access) return null;

  if (!access.pin || new Date(access.expiresAt).getTime() <= Date.now()) {
    await deleteMeta(ADMIN_PRINT_KEY);
    return null;
  }

  return access;
}

async function readAllCheckInsFromMongo() {
  const { db } = await getMongoDb();
  return db.collection<AttendanceCheckIn>('checkIns')
    .find({}, { projection: { _id: 0 } })
    .sort({ checkedInAt: -1 })
    .toArray();
}

async function deleteExpiredCheckIns(checkIns: AttendanceCheckIn[]) {
  const expired = checkIns.filter(item => getCheckInListAge(item) > CHECKIN_PRINT_WINDOW_MS);
  if (expired.length === 0) return checkIns;

  const { db } = await getMongoDb();
  const expiredIds = expired.map(item => item.id);
  await db.collection('checkIns').deleteMany({ id: { $in: expiredIds } });

  const expiredSet = new Set(expiredIds);
  return checkIns.filter(item => !expiredSet.has(item.id));
}

async function readCheckInsFromMongo() {
  const checkIns = await readAllCheckInsFromMongo();
  return deleteExpiredCheckIns(checkIns);
}

export async function GET(request: NextRequest) {
  try {
    const action = request.nextUrl.searchParams.get('action');
    const sessionId = request.nextUrl.searchParams.get('sessionId');
    const level = request.nextUrl.searchParams.get('level');

    const { db } = await getMongoDb();

    if (action === 'activeSessions') return json(await readActiveSessionsFromMongo());
    if (action === 'activeSession') {
      const sessions = await readActiveSessionsFromMongo();
      return json(sessions[0] ?? null);
    }
    if (action === 'adminPrintAccess') return json(await readAdminPrintAccessFromMongo());
    if (action === 'students') {
      const students = await db.collection<RegisteredStudent>('students')
        .find({}, { projection: { _id: 0 } })
        .sort({ registeredAt: -1 })
        .toArray();
      return json(students.map(normalizeStudentRecord));
    }
    if (action === 'studentsByLevel' && level) {
      const students = await db.collection<RegisteredStudent>('students')
        .find({ level }, { projection: { _id: 0 } })
        .sort({ registeredAt: -1 })
        .toArray();
      return json(students);
    }
    if (action === 'checkIns') return json(await readCheckInsFromMongo());
    if (action === 'checkInsBySession' && sessionId) {
      const checkIns = await readCheckInsFromMongo();
      return json(checkIns.filter(checkIn => checkIn.sessionId === sessionId));
    }

    return json({ error: 'Unknown attendance action.' }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Attendance API failed.' }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { db } = await getMongoDb();

    if (body.action === 'saveActiveSession') {
      await setMeta(SESSIONS_KEY, [body.session as ActiveSession]);
      return json({ ok: true });
    }
    if (body.action === 'saveActiveSessions') {
      await setMeta(SESSIONS_KEY, body.sessions as ActiveSession[]);
      return json({ ok: true });
    }
    if (body.action === 'clearActiveSession' || body.action === 'clearActiveSessions') {
      await deleteMeta(SESSIONS_KEY);
      return json({ ok: true });
    }
    if (body.action === 'saveAdminPrintAccess') {
      await setMeta(ADMIN_PRINT_KEY, body.access as AdminPrintAccess);
      return json({ ok: true });
    }
    if (body.action === 'clearAdminPrintAccess') {
      await deleteMeta(ADMIN_PRINT_KEY);
      return json({ ok: true });
    }
    if (body.action === 'saveStudent') {
      const student = normalizeStudentRecord(body.student as RegisteredStudent);
      await db.collection('students').replaceOne({ id: student.id }, student, { upsert: true });
      return json({ ok: true });
    }
    if (body.action === 'deleteStudent') {
      await db.collection('students').deleteOne({ id: body.id });
      return json({ ok: true });
    }
    if (body.action === 'saveCheckIn') {
      const checkIn = body.checkIn as AttendanceCheckIn;
      await db.collection('checkIns').deleteMany({
        sessionId: checkIn.sessionId,
        regNumber: new RegExp(`^${checkIn.regNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      await db.collection('checkIns').replaceOne({ id: checkIn.id }, checkIn, { upsert: true });
      return json({ ok: true });
    }
    if (body.action === 'markCheckInsPrinted') {
      await db.collection('checkIns').updateMany(
        { sessionId: body.sessionId },
        { $set: { printedAt: new Date().toISOString() } },
      );
      return json({ ok: true });
    }
    if (body.action === 'deleteCheckIn') {
      const filter = body.sessionId ? { id: body.id, sessionId: body.sessionId } : { id: body.id };
      await db.collection('checkIns').deleteOne(filter);
      return json({ ok: true });
    }
    if (body.action === 'clearAllCheckIns') {
      await db.collection('checkIns').deleteMany({});
      return json({ ok: true });
    }

    return json({ error: 'Unknown attendance action.' }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Attendance API failed.' }, 500);
  }
}
