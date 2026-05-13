'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  BarChart3,
  ChevronLeft,
  Copy,
  GraduationCap,
  KeyRound,
  Lock,
  Plus,
  Printer,
  ShieldCheck,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ActiveSession,
  AdminPrintAccess,
  AttendanceCheckIn,
  CHECKIN_PRINT_WINDOW_MS,
  clearActiveSessions,
  clearAdminPrintAccess,
  generatePin,
  markCheckInsPrinted,
  readActiveSessions,
  readAdminPrintAccess,
  readCheckIns,
  saveActiveSessions,
  saveAdminPrintAccess,
  SESSION_DURATION_MS,
} from '@/lib/attendance';
import { generateCheckInPDF } from '@/lib/pdfGenerator';

const ATTENDANCE_RADIUS_METERS = 30;

interface LecturePrintOption {
  sessionId: string;
  title: string;
  courseCode?: string;
  lecturerName?: string;
  startedAt?: string;
  isActive: boolean;
  count: number;
  printWindowRemaining: number | null;
}

function formatTimeRemaining(ms: number) {
  const safeMs = Math.max(0, ms);
  const minutes = Math.floor(safeMs / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getPrintWindowRemaining(checkIns: AttendanceCheckIn[], now = Date.now()) {
  const unprinted = checkIns.filter(item => !item.printedAt);
  if (unprinted.length === 0) return null;

  const oldestStartedAt = Math.min(...unprinted.map(item =>
    new Date(item.sessionStartedAt || item.checkedInAt).getTime()
  ));

  return oldestStartedAt + CHECKIN_PRINT_WINDOW_MS - now;
}

function getCurrentLocation() {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('GPS is not available on this device.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
  });
}

function isGeolocationError(error: unknown): error is GeolocationPositionError {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function formatLectureDate(value?: string) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatLectureOption(option: LecturePrintOption) {
  const parts = [
    option.title,
    option.courseCode,
    option.lecturerName,
    formatLectureDate(option.startedAt),
  ].filter(Boolean);

  return `${option.isActive ? 'Active - ' : ''}${parts.join(' | ')}`;
}

interface SessionCardProps {
  session: ActiveSession;
  now: number;
  isCurrentSession: boolean;
  onEnd: (id: string) => void;
  onCopyPin: (pin: string) => void;
}

function SessionCard({ session, now, isCurrentSession, onEnd, onCopyPin }: SessionCardProps) {
  return (
    <div className={`rounded-xl border p-4 ${isCurrentSession ? 'border-emerald-500 bg-emerald-500/5 ring-1 ring-emerald-500/20' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <GraduationCap className={`w-4 h-4 ${isCurrentSession ? 'text-emerald-500' : 'text-slate-400'}`} />
          <span className="font-bold text-sm text-slate-900">{session.courseTitle}</span>
          {session.courseCode && <span className="text-[10px] text-slate-400 font-mono">{session.courseCode}</span>}
        </div>
        <div className="flex items-center gap-2">
          {isCurrentSession && session.lecturerName && (
            <span className="text-[10px] text-slate-400 mr-1">{session.lecturerName}</span>
          )}
          {isCurrentSession && (
            <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
          )}
          <button onClick={() => onEnd(session.id)} className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-red-500 transition-colors" title="End session">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-slate-400 uppercase tracking-widest text-[10px] font-bold mb-1">PIN</p>
          <div className="flex items-center gap-2">
            <span className="font-mono text-lg font-bold text-slate-900 tracking-[0.2em]">{session.pin}</span>
            <button onClick={() => onCopyPin(session.pin)} className="text-slate-400 hover:text-slate-600 transition-colors">
              <Copy className="w-3 h-3" />
            </button>
          </div>
        </div>
        <div>
          <p className="text-slate-400 uppercase tracking-widest text-[10px] font-bold mb-1">Expires</p>
          <p className="font-semibold text-slate-700">{formatTimeRemaining(new Date(session.expiresAt).getTime() - now)}</p>
        </div>
      </div>
      {session.location && (
        <p className="mt-3 text-[10px] font-bold uppercase tracking-wider text-emerald-600">
          Location locked · {session.location.radiusMeters} m radius · ±{Math.round(session.location.accuracy)} m
        </p>
      )}
    </div>
  );
}

export default function LecturerDashboard() {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [courseTitle, setCourseTitle] = useState('');
  const [courseCode, setCourseCode] = useState('');
  const [lecturerName, setLecturerName] = useState('');
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [printAccess, setPrintAccess] = useState<AdminPrintAccess | null>(null);
  const [checkIns, setCheckIns] = useState<AttendanceCheckIn[]>([]);
  const [copied, setCopied] = useState<'session' | 'print' | null>(null);
  const [now, setNow] = useState(0);
  const [courseError, setCourseError] = useState('');
  const [showPrintOptions, setShowPrintOptions] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const [startingSession, setStartingSession] = useState(false);

  // Load sessions
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const activeSessions = await readActiveSessions();
      const access = await readAdminPrintAccess();
      const records = await readCheckIns();
      if (!alive) return;
      setNow(Date.now());
      setSessions(activeSessions);
      setActiveSession(activeSessions.length > 0 ? activeSessions[0] : null);
      setPrintAccess(access);
      setCourseTitle(activeSessions[0]?.courseTitle || '');
      setCourseCode(activeSessions[0]?.courseCode || '');
      setLecturerName(activeSessions[0]?.lecturerName || '');
      setCheckIns(records);
    };
    load();
    return () => { alive = false; };
  }, []);

  // Poll for updates
  useEffect(() => {
    const id = window.setInterval(async () => {
      setNow(Date.now());
      const activeSessions = await readActiveSessions();
      setSessions(activeSessions);
      setActiveSession(activeSessions.length > 0 ? activeSessions[0] : null);
      setPrintAccess(await readAdminPrintAccess());
      setCheckIns(await readCheckIns());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const courseOptions = useMemo(() => {
    const map = new Map<string, LecturePrintOption>();

    sessions.forEach(session => {
      map.set(session.id, {
        sessionId: session.id,
        title: session.courseTitle,
        courseCode: session.courseCode,
        lecturerName: session.lecturerName,
        startedAt: session.startedAt,
        isActive: true,
        count: 0,
        printWindowRemaining: null,
      });
    });

    checkIns.forEach(item => {
      const existing = map.get(item.sessionId);
      if (existing) {
        map.set(item.sessionId, {
          ...existing,
          count: existing.count + 1,
        });
        return;
      }

      map.set(item.sessionId, {
        sessionId: item.sessionId,
        title: item.courseTitle,
        courseCode: item.courseCode,
        lecturerName: item.lecturerName,
        startedAt: item.sessionStartedAt || item.checkedInAt,
        isActive: false,
        count: 1,
        printWindowRemaining: null,
      });
    });

    return Array.from(map.values()).map(option => ({
      ...option,
      printWindowRemaining: getPrintWindowRemaining(
        checkIns.filter(item => item.sessionId === option.sessionId),
        now,
      ),
    })).sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return new Date(b.startedAt || '').getTime() - new Date(a.startedAt || '').getTime();
    });
  }, [checkIns, sessions, now]);

  const visibleCourseOptions = courseOptions.filter(option => option.count > 0);

  const stats = useMemo(
    () => [
      { label: 'Checked In', value: String(checkIns.length), icon: ShieldCheck },
      { label: 'Active Sessions', value: String(sessions.length), icon: GraduationCap },
      { label: 'Current Window', value: activeSession ? formatTimeRemaining(new Date(activeSession.expiresAt).getTime() - now) : '0:00', icon: BarChart3 },
    ],
    [now, sessions, activeSession, checkIns.length]
  );

  const unlock = async () => {
    setPasswordError('');
    try {
      const response = await fetch('/api/lecturer-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password.trim() }),
      });
      const data = await response.json();
      if (response.ok) {
        setUnlocked(true);
      } else {
        setPasswordError(data.error || 'Authentication failed.');
        setPassword('');
      }
    } catch {
      setPasswordError('Unable to verify password. Please try again.');
      setPassword('');
    }
  };

  const startSession = async () => {
    if (startingSession) return;
    const trimmedCourse = courseTitle.trim();
    if (!trimmedCourse) {
      setCourseError('Enter a course title before starting a session.');
      return;
    }

    setStartingSession(true);
    let location: GeolocationPosition;
    try {
      location = await getCurrentLocation();
    } catch (error) {
      if (isGeolocationError(error) && error.code === error.PERMISSION_DENIED) {
        setCourseError('Location permission denied. Allow GPS access so this session can lock to your lecture hall.');
      } else if (isGeolocationError(error) && error.code === error.TIMEOUT) {
        setCourseError('Could not get your location in time. Try again inside the lecture hall.');
      } else {
        setCourseError(error instanceof Error ? error.message : 'Could not lock this session to your current location.');
      }
      setStartingSession(false);
      return;
    }

    const startedAt = new Date();
    const newSession: ActiveSession = {
      id: crypto.randomUUID(),
      courseTitle: trimmedCourse,
      courseCode: courseCode.trim(),
      lecturerName: lecturerName.trim(),
      pin: generatePin(),
      location: {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracy: location.coords.accuracy,
        radiusMeters: ATTENDANCE_RADIUS_METERS,
      },
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + SESSION_DURATION_MS).toISOString(),
    };

    const updatedSessions = [...sessions, newSession];
    await saveActiveSessions(updatedSessions);
    setSessions(updatedSessions);
    setActiveSession(newSession);
    setCourseError('');
    setCopied(null);
    setShowNewSession(false);
    setCourseTitle('');
    setCourseCode('');
    setLecturerName('');
    setStartingSession(false);
  };

  const endSession = useCallback(async (sessionId: string) => {
    const updatedSessions = sessions.filter(s => s.id !== sessionId);
    await saveActiveSessions(updatedSessions);
    setSessions(updatedSessions);
    if (activeSession?.id === sessionId) {
      setActiveSession(updatedSessions.length > 0 ? updatedSessions[0] : null);
    }
    setCopied(null);
  }, [sessions, activeSession]);

  const generateAdminPrintPin = async () => {
    const generatedAt = new Date();
    const access: AdminPrintAccess = {
      pin: generatePin(),
      generatedAt: generatedAt.toISOString(),
      expiresAt: new Date(generatedAt.getTime() + SESSION_DURATION_MS).toISOString(),
    };
    await saveAdminPrintAccess(access);
    setPrintAccess(access);
    setCopied(null);
  };

  const clearAdminPrintPin = async () => {
    await clearAdminPrintAccess();
    setPrintAccess(null);
    setCopied(null);
  };

  const copyPin = async (pin: string) => {
    await navigator.clipboard.writeText(pin);
    setCopied('session');
    window.setTimeout(() => setCopied(null), 1600);
  };

  const copyAdminPrintPin = async () => {
    if (!printAccess) return;
    await navigator.clipboard.writeText(printAccess.pin);
    setCopied('print');
    window.setTimeout(() => setCopied(null), 1600);
  };

  const handleDownloadCheckInPDF = async (sessionId: string) => {
    const selectedCheckIns = checkIns.filter(item => item.sessionId === sessionId);
    const selected = courseOptions.find(option => option.sessionId === sessionId);
    if (selectedCheckIns.length === 0 || !selected) return;

    generateCheckInPDF({
      title: 'UniAttend Check-In Report',
      subtitle: 'Attendance Check-In List',
      totalCount: selectedCheckIns.length,
      courseTitle: selected.title,
      courseCode: selected.courseCode,
      lecturerName: selected.lecturerName,
      lectureDate: formatLectureDate(selected.startedAt),
      checkIns: selectedCheckIns,
      generatedAt: new Date().toLocaleString(),
    });
    await markCheckInsPrinted(sessionId);
    setCheckIns(await readCheckIns());
    setShowPrintOptions(false);
  };

  if (!unlocked) {
    return (
      <main className="min-h-screen bg-slate-950 px-4 py-8 text-white">
        <Link href="/" className="mx-auto flex max-w-md items-center gap-2 text-sm font-semibold text-slate-400 transition-colors hover:text-white">
          <ChevronLeft className="h-5 w-5" /> Back
        </Link>

        <div className="mx-auto mt-16 w-full max-w-md rounded-lg border border-white/10 bg-white/5 p-7 shadow-2xl">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600">
            <Lock className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-2xl font-black">Lecturer Access</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">Enter the preset password to open the session dashboard.</p>

          <div className="mt-6">
            <label className="mb-2 block text-xs font-bold uppercase tracking-widest text-slate-400">Password</label>
            <input
              type="password"
              value={password}
              onChange={event => {
                setPassword(event.target.value);
                setPasswordError('');
              }}
              onKeyDown={async event => { if (event.key === 'Enter') await unlock() }}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition-all focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              autoFocus
            />
            {passwordError && <p className="mt-2 text-xs font-bold text-red-400">{passwordError}</p>}
          </div>

          <button
            onClick={unlock}
            className="mt-5 h-12 w-full rounded-xl bg-blue-600 text-sm font-bold text-white transition-colors hover:bg-blue-500"
          >
            Unlock Dashboard
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
      <main className="min-h-screen bg-slate-50 no-print">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white px-6 py-4">
          <div className="mx-auto flex max-w-6xl items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/" className="rounded-xl p-2 transition-colors hover:bg-slate-100">
                <ChevronLeft className="h-5 w-5 text-slate-500" />
              </Link>
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600">
                <GraduationCap className="h-5 w-5 text-white" />
              </div>
              <div>
                <p className="text-sm font-black leading-none text-slate-900">UniAttend</p>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Lecturer Dashboard</p>
              </div>
            </div>

<div className="flex items-center gap-3">
              <div className={`rounded-xl px-4 py-2 text-xs font-black uppercase tracking-wider ${
                sessions.length > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'
              }`}>
                {sessions.length > 0 ? `${sessions.length} Active Session${sessions.length > 1 ? 's' : ''}` : 'No Active Session'}
              </div>
            </div>
          </div>
        </header>

        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-8 lg:grid-cols-3">
          <section className="lg:col-span-2">
            <div className="border-b border-slate-200 pb-5">
              <h1 className="text-2xl font-black tracking-tight text-slate-900">{sessions.length > 0 ? 'Manage Sessions' : 'Start a Course Session'}</h1>
              <p className="mt-1 text-sm font-medium text-slate-500">Multiple sessions can run simultaneously. Each session has its own 5-digit PIN for 20 minutes.</p>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {stats.map(item => (
                <div key={item.label} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
                    <item.icon className="h-5 w-5" />
                  </div>
                  <p className="text-2xl font-black text-slate-900">{item.value}</p>
                  <p className="mt-1 text-xs font-bold uppercase tracking-wider text-slate-400">{item.label}</p>
                </div>
              ))}
            </div>

            {/* ── New Session ── */}
            <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-5 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-black uppercase tracking-wider text-slate-900">Create New Session</h2>
                  <p className="mt-1 text-sm text-slate-500">Start a new 20-minute check-in session.</p>
                </div>
                <KeyRound className="h-5 w-5 text-blue-600" />
              </div>

              {!showNewSession ? (
                <button onClick={() => setShowNewSession(true)}
                  className="flex items-center gap-2 py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-sm transition-all active:scale-95"
                >
                  <Plus className="w-4 h-4" /> New Session
                </button>
              ) : (
                <div className="grid gap-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="sm:col-span-2">
                      <label className="mb-2 block text-xs font-bold uppercase tracking-widest text-slate-500">Course Title *</label>
                      <input
                        type="text"
                        value={courseTitle}
                        onChange={event => {
                          setCourseTitle(event.target.value);
                          setCourseError('');
                        }}
                        placeholder="e.g. General Mathematics II"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-xs font-bold uppercase tracking-widest text-slate-500">Course Code</label>
                      <input
                        type="text"
                        value={courseCode}
                        onChange={event => { setCourseCode(event.target.value); setCourseError(''); }}
                        placeholder="e.g. MTH201"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-xs font-bold uppercase tracking-widest text-slate-500">Lecturer Name</label>
                      <input
                        type="text"
                        value={lecturerName}
                        onChange={event => { setLecturerName(event.target.value); setCourseError(''); }}
                        placeholder="e.g. Dr. Smith"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                      />
                    </div>
                  </div>
                  {courseError && <p className="text-xs font-bold text-red-500">{courseError}</p>}
                  <div className="flex flex-wrap gap-2">
                    <button onClick={startSession}
                      disabled={startingSession}
                      className="flex h-12 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ShieldCheck className="h-4 w-4" /> {startingSession ? 'Locking Location...' : 'Start Session'}
                    </button>
                    <button onClick={() => { setShowNewSession(false); setCourseError(''); }}
                      className="flex h-12 items-center justify-center gap-2 rounded-xl bg-slate-200 px-4 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-300"
                    >
                      <X className="h-4 w-4" /> Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* ── Active Sessions List ── */}
            {sessions.length > 0 && (
              <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-sm font-black uppercase tracking-wider text-slate-900 mb-4">Active Sessions</h2>
                <div className="grid grid-cols-1 gap-3">
                  {sessions.map(session => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      now={now}
                      isCurrentSession={activeSession?.id === session.id}
                      onEnd={endSession}
                      onCopyPin={copyPin}
                    />
                  ))}
                </div>
                <AnimatePresence>
                  {copied === 'session' && (
                    <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                      className="mt-3 text-xs font-bold text-emerald-600"
                    >
                      Session PIN copied to clipboard.
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
            )}
          </section>

          <aside className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-black uppercase tracking-wider text-slate-900">Checked-In Lists</h2>
                <button
                  onClick={() => setShowPrintOptions(true)}
                  disabled={visibleCourseOptions.length === 0}
                  className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Choose lecture list to print"
                >
                  <Printer className="w-4 h-4" /> Print
                </button>
              </div>
              <p className="text-xs font-semibold text-slate-500">Each course list stays visible until its unprinted records expire after 1 hour.</p>
            </div>

            <div className="mt-5 space-y-3 max-h-96 overflow-y-auto">
              {visibleCourseOptions.length === 0 ? (
                <p className="rounded-lg bg-slate-50 p-4 text-sm font-semibold text-slate-500">No check-in lists yet.</p>
              ) : (
                visibleCourseOptions.map(option => (
                  <div key={option.sessionId} className="rounded-lg border border-slate-100 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black text-slate-900">{option.title}</p>
                        <p className="mt-1 truncate text-xs font-semibold text-slate-400">
                          {[option.courseCode, option.lecturerName, formatLectureDate(option.startedAt)].filter(Boolean).join(' | ') || 'Lecture session'}
                        </p>
                      </div>
                      <div className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-center text-white">
                        <p className="text-lg font-black leading-none">{option.count}</p>
                        <p className="mt-1 text-[9px] font-bold uppercase tracking-wider text-slate-300">Students</p>
                      </div>
                    </div>
                    {option.printWindowRemaining !== null && (
                      <p className={`mt-3 text-xs font-bold ${option.printWindowRemaining > 0 ? 'text-amber-600' : 'text-red-600'}`}>
                        Print window: {formatTimeRemaining(option.printWindowRemaining)} remaining
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Print PIN section */}
            <div className="mt-6 pt-6 border-t border-slate-200">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-black uppercase tracking-wider text-slate-900">Admin Registry Print PIN</h2>
                <Printer className="h-4 w-4 text-slate-700" />
              </div>

              <div className="flex flex-col gap-3">
                <div>
                  <div className="min-h-16 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-3xl font-black tracking-[0.2em] text-slate-900">
                    {printAccess ? printAccess.pin : <span className="text-slate-300 text-sm">No PIN generated</span>}
                  </div>
                  <p className="mt-2 text-xs font-bold text-slate-400">
                    {printAccess ? `Expires in ${formatTimeRemaining(new Date(printAccess.expiresAt).getTime() - now)}` : 'Generate a PIN to enable admin printing.'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={copyAdminPrintPin}
                    disabled={!printAccess}
                    className="flex h-10 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Copy className="h-4 w-4" /> Copy
                  </button>
                  {printAccess ? (
                    <button
                      onClick={clearAdminPrintPin}
                      className="flex h-10 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white transition-colors hover:bg-slate-800"
                    >
                      <X className="h-4 w-4" /> Clear
                    </button>
                  ) : (
                    <button
                      onClick={generateAdminPrintPin}
                      className="flex h-10 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white transition-colors hover:bg-blue-700"
                    >
                      <Printer className="h-4 w-4" /> Generate PIN
                    </button>
                  )}
                </div>
              </div>

              <AnimatePresence>
                {copied === 'print' && (
                  <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                    className="mt-3 text-xs font-bold text-emerald-600"
                  >
                    Admin print PIN copied to clipboard.
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </aside>
        </div>
      </main>

      <AnimatePresence>
        {showPrintOptions && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl"
            >
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-black text-slate-900">Print Check-In List</h2>
                  <p className="mt-1 text-sm font-semibold text-slate-500">Choose the lecture list to download.</p>
                </div>
                <button
                  onClick={() => setShowPrintOptions(false)}
                  className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="max-h-96 space-y-3 overflow-y-auto">
                {visibleCourseOptions.length === 0 ? (
                  <p className="rounded-lg bg-slate-50 p-4 text-sm font-semibold text-slate-500">No lecture has students checked in yet.</p>
                ) : (
                  visibleCourseOptions.map(option => (
                    <button
                      key={option.sessionId}
                      onClick={() => handleDownloadCheckInPDF(option.sessionId)}
                      className="w-full rounded-lg border border-slate-200 p-4 text-left transition-colors hover:border-blue-300 hover:bg-blue-50"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black text-slate-900">{formatLectureOption(option)}</p>
                          {option.printWindowRemaining !== null && (
                            <p className={`mt-2 text-xs font-bold ${option.printWindowRemaining > 0 ? 'text-amber-600' : 'text-red-600'}`}>
                              Print window: {formatTimeRemaining(option.printWindowRemaining)} remaining
                            </p>
                          )}
                        </div>
                        <span className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-xs font-black text-white">
                          {option.count} student{option.count !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
