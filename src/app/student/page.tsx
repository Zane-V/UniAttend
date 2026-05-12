'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, Key, Navigation,
  Scan, CheckCircle2, ShieldCheck, Smartphone,
  MapPin, Eye
} from 'lucide-react';
import Link from 'next/link';
import {
  ActiveSession,
  normalizeRegNumber,
  readActiveSessions,
  readStudents,
  RegisteredStudent,
  saveCheckIn,
} from '@/lib/attendance';
import {
  FaceAnalysisResult,
  detectFaceAnalyses,
  detectFaceDescriptors,
  faceConfidence as calculateFaceConfidence,
  FACE_MATCH_THRESHOLD,
  faceDistance,
  imageFromDataUrl,
} from '@/lib/faceRecognition';

type Step = 'login' | 'gps' | 'biometric' | 'success';
type GpsStatus = 'idle' | 'checking' | 'verified' | 'rejected' | 'error';
type BiometricStatus = 'idle' | 'camera' | 'scanning' | 'verified' | 'rejected' | 'error';
type LivenessStatus = 'idle' | 'waiting' | 'verified' | 'rejected';

const steps = [
  { key: 'login', label: 'Knowledge', icon: Key, color: 'bg-blue-600' },
  { key: 'gps', label: 'Geography', icon: Navigation, color: 'bg-emerald-600' },
  { key: 'biometric', label: 'Biometrics', icon: Scan, color: 'bg-violet-600' },
];

const LIVENESS_SAMPLE_COUNT = 12;
const LIVENESS_SAMPLE_DELAY_MS = 180;
const MIN_OPEN_EYE_RATIO = 0.18;
const MIN_BLINK_DROP_RATIO = 0.24;
const MIN_LIVENESS_BRIGHTNESS = 38;

function distanceInMeters(from: GeolocationCoordinates, to: { latitude: number; longitude: number }) {
  const earthRadiusMeters = 6371000;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);
  const latDelta = toRadians(to.latitude - from.latitude);
  const lonDelta = toRadians(to.longitude - from.longitude);
  const a = Math.sin(latDelta / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(lonDelta / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointDistance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function eyeAspectRatio(eye: Array<{ x: number; y: number }>) {
  if (eye.length < 6) return 0;
  const vertical = pointDistance(eye[1], eye[5]) + pointDistance(eye[2], eye[4]);
  const horizontal = pointDistance(eye[0], eye[3]);
  return horizontal === 0 ? 0 : vertical / (2 * horizontal);
}

function faceEyeRatio(face: FaceAnalysisResult) {
  return (eyeAspectRatio(face.landmarks.leftEye) + eyeAspectRatio(face.landmarks.rightEye)) / 2;
}

function wait(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function getCanvasBrightness(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d');
  if (!context || canvas.width === 0 || canvas.height === 0) return 0;

  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  let total = 0;
  let samples = 0;

  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const index = (y * width + x) * 4;
      total += 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
      samples += 1;
    }
  }

  return total / Math.max(1, samples);
}

export default function StudentPortal() {
  const [step, setStep] = useState<Step>('login');
  const [loading, setLoading] = useState(false);
  const [regNumber, setRegNumber] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [student, setStudent] = useState<RegisteredStudent | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('idle');
  const [gpsError, setGpsError] = useState('');
  const [gpsDistance, setGpsDistance] = useState<number | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [biometricStatus, setBiometricStatus] = useState<BiometricStatus>('idle');
  const [biometricError, setBiometricError] = useState('');
  const [faceMatchConfidence, setFaceMatchConfidence] = useState<number | null>(null);
  const [livenessStatus, setLivenessStatus] = useState<LivenessStatus>('idle');
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let alive = true;
    readActiveSessions().then(sessions => {
      if (alive) setActiveSession(sessions.length > 0 ? sessions[0] : null);
    });
    return () => { alive = false; };
  }, []);

  const advance = (target: Step) => {
    setLoading(true);
    setTimeout(() => { setStep(target); setLoading(false); }, 1400);
  };

  const stopBiometricCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const currentStepIndex = steps.findIndex(s => s.key === step);
  const courseTitle = activeSession?.courseTitle || 'Current Session';
  const sessionLocation = activeSession?.location;

  const verifyKnowledge = async () => {
    const normalizedRegNumber = normalizeRegNumber(regNumber);
    const enteredPin = pin.trim();

    if (!normalizedRegNumber) {
      setError('Enter your registration number to continue.');
      return;
    }

    if (!enteredPin) {
      setError('Enter the session PIN from your lecturer to continue.');
      return;
    }

    const found = (await readStudents()).find(item => normalizeRegNumber(item.regNumber) === normalizedRegNumber);
    if (!found) {
      setError('Student does not exist. Please register on the admin dashboard before checking in.');
      return;
    }

    const sessions = await readActiveSessions();
    if (sessions.length === 0) {
      setError('No active session. Ask your lecturer to start a session first.');
      return;
    }

    const session = sessions.find(s => s.pin === enteredPin);
    if (!session) {
      setError('Incorrect or expired session PIN. Ask your lecturer for the correct PIN.');
      setPin('');
      return;
    }

    setActiveSession(session);
    setStudent(found);
    setError('');
    setGpsStatus('idle');
    setGpsError('');
    setGpsDistance(null);
    setGpsAccuracy(null);
    setBiometricStatus('idle');
    setBiometricError('');
    setFaceMatchConfidence(null);
    setLivenessStatus('idle');
    advance('gps');
  };

  const verifyLocation = () => {
    setGpsStatus('checking');
    setGpsError('');
    setGpsDistance(null);
    setGpsAccuracy(null);

    if (!navigator.geolocation) {
      setGpsStatus('error');
      setGpsError('GPS is not available on this device. You cannot check in without location verification.');
      return;
    }

    if (!sessionLocation) {
      setGpsStatus('error');
      setGpsError('This session does not have a lecturer location lock. Ask your lecturer to restart the session with GPS enabled.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      position => {
        const distance = distanceInMeters(position.coords, sessionLocation);
        setGpsDistance(distance);
        setGpsAccuracy(position.coords.accuracy);

        if (distance > sessionLocation.radiusMeters) {
          setGpsStatus('rejected');
          setGpsError('Student is not in attendance. You are not near the lecture hall and cannot check in.');
          return;
        }

        setGpsStatus('verified');
      },
      locationError => {
        setGpsStatus('error');
        if (locationError.code === locationError.PERMISSION_DENIED) {
          setGpsError('Location permission denied. Allow GPS access to verify attendance.');
          return;
        }
        if (locationError.code === locationError.TIMEOUT) {
          setGpsError('GPS check timed out. Move to an open area near the lecture hall and try again.');
          return;
        }
        setGpsError('Could not verify your GPS location. Try again near the lecture hall.');
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      },
    );
  };

  const completeCheckIn = async (verifiedFaceConfidence?: number) => {
    const sessions = await readActiveSessions();
    const session = sessions.find(s => s.id === activeSession?.id);
    if (!session || !student) {
      setError('The session expired. Ask your lecturer to start a new session.');
      setStep('login');
      return;
    }

    if (gpsStatus !== 'verified') {
      setGpsError('Verify your lecture hall location before completing check-in.');
      setStep('gps');
      return;
    }

    if (verifiedFaceConfidence === undefined && biometricStatus !== 'verified') {
      setBiometricError('Verify your face before completing check-in.');
      setStep('biometric');
      return;
    }

    await saveCheckIn({
      id: crypto.randomUUID(),
      sessionId: session.id,
      courseTitle: session.courseTitle,
      courseCode: session.courseCode,
      lecturerName: session.lecturerName,
      sessionStartedAt: session.startedAt,
      regNumber: student.regNumber,
      name: student.name,
      faculty: student.faculty,
      department: student.department,
      level: student.level,
      checkedInAt: new Date().toISOString(),
    });

    stopBiometricCamera();
    advance('success');
  };

  const startBiometricCamera = async () => {
    setBiometricError('');
    setFaceMatchConfidence(null);
    setLivenessStatus('waiting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setBiometricStatus('camera');
    } catch (error: unknown) {
      setBiometricStatus('error');
      setBiometricError(error instanceof Error && error.name === 'NotAllowedError'
        ? 'Camera permission denied. Allow camera access to verify your face.'
        : 'Could not access the camera for face verification.');
    }
  };

  const getRegisteredDescriptor = async () => {
    if (!student) return null;
    if (student.faceDescriptor?.length) return student.faceDescriptor;
    if (!student.faceImage) return null;

    const registeredImage = await imageFromDataUrl(student.faceImage);
    const registeredFaces = await detectFaceDescriptors(registeredImage);
    if (registeredFaces.length !== 1) return null;
    return registeredFaces[0].descriptor;
  };

  const captureFaceAnalysis = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return { faces: [], brightness: 0 };

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return {
      faces: await detectFaceAnalyses(canvas),
      brightness: getCanvasBrightness(canvas),
    };
  };

  const runBlinkLivenessCheck = async () => {
    setLivenessStatus('waiting');

    const eyeRatios: number[] = [];
    let lastFace: FaceAnalysisResult | null = null;

    for (let index = 0; index < LIVENESS_SAMPLE_COUNT; index += 1) {
      const { faces, brightness } = await captureFaceAnalysis();

      if (brightness < MIN_LIVENESS_BRIGHTNESS) {
        return {
          ok: false,
          face: null,
          message: 'The camera view is too dim for reliable liveness. Face a brighter area, increase your screen brightness, or ask the lecturer to switch on more light, then try again.',
        };
      }

      if (faces.length !== 1) {
        return {
          ok: false,
          face: null,
          message: faces.length === 0
            ? 'No face detected during liveness check. Keep your face visible and blink once.'
            : 'More than one face detected during liveness check. Only the registered student can be in frame.',
        };
      }

      lastFace = faces[0];
      eyeRatios.push(faceEyeRatio(faces[0]));
      await wait(LIVENESS_SAMPLE_DELAY_MS);
    }

    const maxEyeRatio = Math.max(...eyeRatios);
    const minEyeRatio = Math.min(...eyeRatios);
    const blinkDrop = maxEyeRatio === 0 ? 0 : (maxEyeRatio - minEyeRatio) / maxEyeRatio;

    if (maxEyeRatio < MIN_OPEN_EYE_RATIO || blinkDrop < MIN_BLINK_DROP_RATIO) {
      return {
        ok: false,
        face: lastFace,
        message: 'Liveness check failed. Blink once clearly while looking at the camera, then try again.',
      };
    }

    setLivenessStatus('verified');
    return { ok: true, face: lastFace, message: '' };
  };

  const verifyBiometric = async () => {
    if (!videoRef.current || !canvasRef.current || !student) return;

    setBiometricStatus('scanning');
    setBiometricError('');
    setFaceMatchConfidence(null);
    setLivenessStatus('waiting');

    let registeredDescriptor: number[] | null;
    let livenessResult;
    try {
      registeredDescriptor = await getRegisteredDescriptor();
      livenessResult = await runBlinkLivenessCheck();
    } catch {
      setBiometricStatus('error');
      setBiometricError('Could not scan the face. Keep your face visible and try again.');
      setLivenessStatus('rejected');
      return;
    }

    if (!registeredDescriptor) {
      setBiometricStatus('error');
      setBiometricError('No usable registered face record was found. Please register again at the admin dashboard.');
      setLivenessStatus('rejected');
      return;
    }

    if (!livenessResult.ok || !livenessResult.face) {
      setBiometricStatus('rejected');
      setBiometricError(livenessResult.message);
      setLivenessStatus('rejected');
      return;
    }

    const distance = faceDistance(registeredDescriptor, livenessResult.face.descriptor);
    const confidence = calculateFaceConfidence(distance);
    setFaceMatchConfidence(confidence);

    if (distance > FACE_MATCH_THRESHOLD) {
      setBiometricStatus('rejected');
      setBiometricError('Face verification failed. This face does not match the registered student record.');
      setLivenessStatus('verified');
      return;
    }

    setBiometricStatus('verified');
    await completeCheckIn(confidence);
  };

  useEffect(() => () => stopBiometricCamera(), [stopBiometricCamera]);

  return (
    <div className="min-h-screen bg-[#0f172a] flex flex-col relative overflow-hidden">
      {/* Ambient glows */}
      <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-blue-600/10 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-emerald-600/8 rounded-full blur-[120px] pointer-events-none"></div>

      {/* Header */}
      <header className="relative z-10 flex items-center justify-between px-6 py-5 border-b border-white/5">
        <Link href="/" className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-semibold">
          <ChevronLeft className="w-5 h-5" /> Back
        </Link>
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-blue-500" />
          <span className="text-white font-black">UniAttend</span>
        </div>
        <div className="text-xs text-slate-500 font-medium">Student Portal</div>
      </header>

      {/* Main */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          {/* Progress bar */}
          {step !== 'success' && (
            <div className="mb-10">
              <div className="flex items-center justify-between mb-3">
                {steps.map((s, i) => {
                  const done = i < currentStepIndex;
                  const active = s.key === step;
                  return (
                    <div key={s.key} className="flex items-center gap-2">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black border-2 transition-all duration-500 ${
                        done ? 'bg-emerald-500 border-emerald-500 text-white' :
                        active ? `${s.color} border-transparent text-white scale-110 shadow-lg` :
                        'border-white/10 text-slate-600'
                      }`}>
                        {done ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
                      </div>
                      {i < steps.length - 1 && (
                        <div className={`h-[2px] w-20 sm:w-32 rounded-full transition-all duration-700 ${done ? 'bg-emerald-500' : 'bg-white/10'}`}></div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between px-1">
                {steps.map(s => (
                  <span key={s.key} className="text-[10px] font-bold uppercase tracking-wider text-slate-600">{s.label}</span>
                ))}
              </div>
            </div>
          )}

          {/* Step Content */}
          <AnimatePresence mode="wait">
            {/* ── Step 1: Knowledge ─────────── */}
            {step === 'login' && (
              <motion.div key="login" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-8 mb-5 shadow-2xl">
                  <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center mb-6 shadow-xl shadow-blue-500/20">
                    <Key className="w-7 h-7 text-white" />
                  </div>
                  <h1 className="text-2xl font-black text-white mb-1">Layer 1: Knowledge</h1>
                  <p className="text-slate-400 text-sm mb-8 leading-relaxed">
                    Enter your registration number and the 5-digit PIN displayed by your lecturer.
                    {activeSession && <span className="block mt-2 text-blue-300 font-bold">{activeSession.courseTitle}</span>}
                  </p>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Registration Number</label>
                      <input
                        type="text"
                        value={regNumber}
                        onChange={event => { setRegNumber(normalizeRegNumber(event.target.value)); setError(''); }}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-5 py-4 text-white outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all placeholder-slate-600 font-mono"
                        placeholder="24/SC/CO/001"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">5-Digit Session PIN</label>
                      <input
                        type="password"
                        value={pin}
                        onChange={event => { setPin(event.target.value); setError(''); }}
                        onKeyDown={event => event.key === 'Enter' && verifyKnowledge()}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-5 py-4 text-white outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all placeholder-slate-600 tracking-[0.5em] text-xl"
                        placeholder="•••••"
                        maxLength={5}
                      />
                    </div>
                  </div>
                  {error && <p className="mt-4 text-xs font-bold text-red-400">{error}</p>}
                </div>

                <button
                  onClick={verifyKnowledge}
                  disabled={loading || !regNumber.trim() || pin.length < 5}
                  className="w-full h-14 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white rounded-2xl font-bold flex items-center justify-center gap-2 transition-all shadow-xl shadow-blue-600/20"
                >
                  {loading
                    ? <div className="w-5 h-5 border-2 border-white/40 border-t-white rounded-full animate-spin"></div>
                    : 'Verify → Check GPS'
                  }
                </button>
              </motion.div>
            )}

            {/* ── Step 2: GPS ───────────────── */}
            {step === 'gps' && (
              <motion.div key="gps" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-8 mb-5 shadow-2xl">
                  <div className="w-14 h-14 bg-emerald-600 rounded-2xl flex items-center justify-center mb-6 shadow-xl shadow-emerald-500/20">
                    <Navigation className="w-7 h-7 text-white" />
                  </div>
                  <h1 className="text-2xl font-black text-white mb-1">Layer 2: Geography</h1>
                  <p className="text-slate-400 text-sm mb-8 leading-relaxed">
                    Verifying you are physically inside the lecture hall for {courseTitle}. GPS is checked against the lecturer&apos;s session location.
                  </p>

                  {/* Map placeholder */}
                  <div className="aspect-[16/9] bg-slate-900/60 rounded-2xl border border-white/5 mb-5 relative overflow-hidden flex flex-col items-center justify-center">
                    <div className="absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_50%_50%,_#3b82f6,_transparent_70%)]"></div>
                    {/* Grid lines */}
                    <div className="absolute inset-0 opacity-10">
                      {[...Array(8)].map((_,i) => (
                        <div key={i} className="absolute top-0 h-full border-l border-blue-400" style={{ left: `${(i+1)*12.5}%` }}></div>
                      ))}
                      {[...Array(5)].map((_,i) => (
                        <div key={i} className="absolute left-0 w-full border-t border-blue-400" style={{ top: `${(i+1)*20}%` }}></div>
                      ))}
                    </div>
                    {/* Pulsing pin */}
                    <div className="relative">
                      <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center">
                        <div className="w-10 h-10 bg-emerald-500/40 rounded-full flex items-center justify-center">
                          <MapPin className="w-6 h-6 text-emerald-400" />
                        </div>
                      </div>
                      <div className="absolute inset-0 bg-emerald-500/20 rounded-full animate-ping"></div>
                    </div>
                    <p className="mt-3 text-emerald-400 text-xs font-mono">
                      {sessionLocation
                        ? `${sessionLocation.latitude.toFixed(4)}° N, ${sessionLocation.longitude.toFixed(4)}° E · ${sessionLocation.radiusMeters} m`
                        : 'Waiting for lecturer location'}
                    </p>
                  </div>

                  {gpsStatus === 'verified' && (
                    <div className="flex items-center gap-3 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl text-emerald-400 text-sm font-bold">
                      <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
                      Location verified — {Math.round(gpsDistance || 0)} m from lecture hall
                      {gpsAccuracy !== null && <span className="text-emerald-300/70">±{Math.round(gpsAccuracy)} m</span>}
                    </div>
                  )}

                  {(gpsStatus === 'rejected' || gpsStatus === 'error') && (
                    <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-300 text-sm font-bold">
                      <MapPin className="w-5 h-5 flex-shrink-0" />
                      {gpsError}
                      {gpsDistance !== null && <span className="text-red-200/70">{Math.round(gpsDistance)} m away</span>}
                    </div>
                  )}
                </div>

                <button
                  onClick={gpsStatus === 'verified' ? () => advance('biometric') : verifyLocation}
                  disabled={loading || gpsStatus === 'checking'}
                  className="w-full h-14 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white rounded-2xl font-bold flex items-center justify-center gap-2 transition-all shadow-xl shadow-emerald-600/20"
                >
                  {loading || gpsStatus === 'checking'
                    ? <div className="w-5 h-5 border-2 border-white/40 border-t-white rounded-full animate-spin"></div>
                    : gpsStatus === 'verified' ? 'Proceed to Biometrics' : 'Verify Location'
                  }
                </button>
              </motion.div>
            )}

            {/* ── Step 3: Biometric ─────────── */}
            {step === 'biometric' && (
              <motion.div key="biometric" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-8 mb-5 shadow-2xl">
                  <div className="w-14 h-14 bg-violet-600 rounded-2xl flex items-center justify-center mb-6 shadow-xl shadow-violet-500/20">
                    <Scan className="w-7 h-7 text-white" />
                  </div>
                  <h1 className="text-2xl font-black text-white mb-1">Layer 3: Biometrics</h1>
                  <p className="text-slate-400 text-sm mb-6 leading-relaxed">
                    Face the camera alone and blink once during the scan. Your live face will be compared with the registered student record.
                  </p>
                  <div className="mb-5 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-xs font-bold leading-relaxed text-amber-200">
                    If the hall is dim, face the brightest side of the room or raise your phone screen brightness before scanning.
                  </div>

                  <div className="aspect-[3/4] bg-slate-900 rounded-2xl border-2 border-violet-500/30 relative overflow-hidden mb-5">
                    <canvas ref={canvasRef} className="hidden" />
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className={`h-full w-full object-cover ${biometricStatus === 'camera' || biometricStatus === 'scanning' ? '' : 'hidden'}`}
                    />

                    {biometricStatus !== 'camera' && biometricStatus !== 'scanning' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                        <Scan className="w-12 h-12 text-violet-300/30" />
                        <p className="text-xs font-bold text-slate-500">Camera inactive</p>
                      </div>
                    )}

                    {['top-4 left-4', 'top-4 right-4', 'bottom-4 left-4', 'bottom-4 right-4'].map((pos, i) => (
                      <div key={i} className={`absolute ${pos} w-6 h-6 border-violet-400`} style={{
                        borderTop: i < 2 ? '2px solid' : 'none',
                        borderBottom: i >= 2 ? '2px solid' : 'none',
                        borderLeft: i % 2 === 0 ? '2px solid' : 'none',
                        borderRight: i % 2 !== 0 ? '2px solid' : 'none',
                        borderColor: 'rgb(167 139 250)',
                      }}></div>
                    ))}

                    {biometricStatus === 'scanning' && (
                      <motion.div
                        className="absolute left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-violet-400 to-transparent shadow-[0_0_12px_rgba(167,139,250,0.8)]"
                        animate={{ top: ['20%', '80%', '20%'] }}
                        transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                      ></motion.div>
                    )}

                    <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/60 to-transparent">
                      <div className="flex items-center gap-2 bg-violet-600/80 backdrop-blur-sm px-3 py-2 rounded-xl text-xs font-black text-white uppercase tracking-widest">
                        <Eye className="w-4 h-4 animate-pulse" />
                        Blink once during scan
                      </div>
                    </div>
                  </div>

                  {(biometricStatus === 'camera' || biometricStatus === 'scanning' || livenessStatus === 'verified') && (
                    <div className={`mb-4 flex items-center gap-3 p-4 rounded-2xl text-sm font-bold ${
                      livenessStatus === 'verified'
                        ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                        : livenessStatus === 'rejected'
                          ? 'bg-red-500/10 border border-red-500/20 text-red-300'
                          : 'bg-violet-500/10 border border-violet-500/20 text-violet-300'
                    }`}>
                      {livenessStatus === 'verified' ? <CheckCircle2 className="w-5 h-5 flex-shrink-0" /> : <Eye className="w-5 h-5 flex-shrink-0" />}
                      {livenessStatus === 'verified'
                        ? 'Liveness verified'
                        : biometricStatus === 'scanning'
                          ? 'Checking for a real blink...'
                          : 'When scanning starts, blink once clearly.'}
                    </div>
                  )}

                  {(biometricStatus === 'camera' || biometricStatus === 'scanning' || biometricStatus === 'verified') && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs font-bold text-slate-400">
                        <span>{biometricStatus === 'verified' ? 'Face matched' : 'Matching live face...'}</span>
                        <span className="text-violet-400">{faceMatchConfidence ?? 0}%</span>
                      </div>
                      <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-violet-500 rounded-full"
                          initial={{ width: '0%' }}
                          animate={{ width: `${faceMatchConfidence ?? (biometricStatus === 'scanning' ? 45 : 0)}%` }}
                          transition={{ duration: 0.6, ease: 'easeOut' }}
                        ></motion.div>
                      </div>
                    </div>
                  )}

                  {biometricError && (
                    <div className="mt-4 flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-300 text-sm font-bold">
                      <Scan className="w-5 h-5 flex-shrink-0" />
                      {biometricError}
                    </div>
                  )}
                </div>

                <button
                  onClick={biometricStatus === 'camera' || biometricStatus === 'rejected' || biometricStatus === 'error' ? verifyBiometric : startBiometricCamera}
                  disabled={loading || biometricStatus === 'scanning'}
                  className="w-full h-14 bg-violet-600 hover:bg-violet-500 active:scale-95 text-white rounded-2xl font-bold flex items-center justify-center gap-2 transition-all shadow-xl shadow-violet-600/20"
                >
                  {loading || biometricStatus === 'scanning'
                    ? <div className="w-5 h-5 border-2 border-white/40 border-t-white rounded-full animate-spin"></div>
                    : biometricStatus === 'camera' || biometricStatus === 'rejected' || biometricStatus === 'error' ? 'Run Liveness & Complete Check-In' : 'Start Face Camera'
                  }
                </button>
              </motion.div>
            )}

            {/* ── Success ───────────────────── */}
            {step === 'success' && (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-center py-8"
              >
                {/* Ripple checkmark */}
                <div className="relative w-28 h-28 mx-auto mb-8">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="absolute inset-0 bg-emerald-500/20 rounded-full"
                  ></motion.div>
                  <div className="absolute inset-0 flex items-center justify-center bg-emerald-500 rounded-full shadow-2xl shadow-emerald-500/40">
                    <CheckCircle2 className="w-14 h-14 text-white" />
                  </div>
                </div>

                <h1 className="text-3xl font-black text-white mb-2">Attendance Marked!</h1>
                <p className="text-slate-400 mb-8 text-sm max-w-xs mx-auto leading-relaxed">
                  You have been successfully checked in to{' '}
                  <span className="text-white font-bold">{courseTitle}</span>.
                </p>

                {/* Receipt */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 text-left mb-8 space-y-3">
                  {[
                    { label: 'Time', value: new Date().toLocaleTimeString() },
                    { label: 'Session', value: courseTitle },
                    { label: 'Student', value: student?.name || 'Registered student' },
                    { label: 'Device', value: 'Any Device', icon: <Smartphone className="w-3.5 h-3.5 inline ml-1 opacity-60" /> },
                    { label: 'Face Confidence', value: `${faceMatchConfidence ?? 0}%`, highlight: true },
                    { label: 'GPS', value: 'Hall verified ✓', highlight: true },
                  ].map(item => (
                    <div key={item.label} className="flex justify-between items-center text-sm">
                      <span className="text-slate-500 font-bold uppercase tracking-tighter text-xs">{item.label}</span>
                      <span className={`font-bold ${item.highlight ? 'text-emerald-400' : 'text-white'}`}>
                        {item.value}{item.icon}
                      </span>
                    </div>
                  ))}
                </div>

                <Link
                  href="/"
                  className="block w-full h-14 bg-white/10 hover:bg-white/20 border border-white/10 text-white rounded-2xl font-bold flex items-center justify-center transition-all"
                >
                  Return to Home
                </Link>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
