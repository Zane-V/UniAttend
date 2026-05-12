'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Camera, Search, Printer, ChevronLeft, ChevronRight, X, ShieldCheck, Eye, EyeOff, Lock, RefreshCw, Trash2 } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import {
  deleteStudent,
  normalizeAcademicText,
  normalizeLevel,
  normalizeRegNumber,
  normalizeStudentRecord,
  readAdminPrintAccess,
  readStudents,
  RegisteredStudent,
  saveStudent,
} from '@/lib/attendance';
import { detectFaceDescriptors } from '@/lib/faceRecognition';
import { generateStudentRegistryPDF } from '@/lib/pdfGenerator';

interface CaptureQuality {
  ok: boolean;
  score: number;
  message: string;
}

const PER_PAGE = 10;
const MIN_CAPTURE_SCORE = 65;
const LEVEL_OPTIONS = ['100L', '200L', '300L', '400L', '500L'];

function analyzeCaptureQuality(canvas: HTMLCanvasElement): CaptureQuality {
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width < 240 || canvas.height < 180) {
      return { ok: false, score: 0, message: 'The camera image is too small. Move closer and capture again.' };
    }

    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let total = 0;
    let totalSquared = 0;
    let samples = 0;

    // For eye detection: we'll store the gray samples at step 4
    const samplesPerRow = Math.ceil(width / 4);
    const samplesPerCol = Math.ceil(height / 4);
    const graySamples = new Float32Array(samplesPerRow * samplesPerCol);

    // First pass: step 4 for brightness and storing samples
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const index = (y * width + x) * 4;
        const gray = 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
        total += gray;
        totalSquared += gray * gray;
        samples += 1;

        // Store the gray sample
        const sampleY = Math.floor(y / 4);
        const sampleX = Math.floor(x / 4);
        const sampleIndex = sampleY * samplesPerRow + sampleX;
        graySamples[sampleIndex] = gray;
      }
    }

    const brightness = total / samples;
    const contrast = Math.sqrt(totalSquared / samples - brightness * brightness);
    let edgeTotal = 0;
    let edgeSamples = 0;

    // Second pass: step 8 for sharpness
    for (let y = 8; y < height - 8; y += 8) {
      for (let x = 8; x < width - 8; x += 8) {
        const center = (y * width + x) * 4;
        const right = (y * width + x + 1) * 4;
        const down = ((y + 1) * width + x) * 4;
        const centerGray = 0.299 * data[center] + 0.587 * data[center + 1] + 0.114 * data[center + 2];
        const rightGray = 0.299 * data[right] + 0.587 * data[right + 1] + 0.114 * data[right + 2];
        const downGray = 0.299 * data[down] + 0.587 * data[down + 1] + 0.114 * data[down + 2];
        edgeTotal += Math.abs(centerGray - rightGray) + Math.abs(centerGray - downGray);
        edgeSamples += 1;
      }
    }

    const sharpness = edgeTotal / Math.max(1, edgeSamples);
    const blockingIssues: string[] = [];
    const tips: string[] = [];

    if (brightness < 28) blockingIssues.push('the image is too dark');
    if (brightness > 242) blockingIssues.push('the image is too bright');
    if (contrast < 8) blockingIssues.push('the image has almost no visible detail');

    // NEW: Eye detection in the upper half
    let eyeCandidates = 0;
    let minEyeX = samplesPerRow; // initialize to max
    let maxEyeX = 0;

    for (let sampleY = 0; sampleY < Math.floor(samplesPerCol / 2); sampleY++) { // upper half
      for (let sampleX = 0; sampleX < samplesPerRow; sampleX++) {
        const index = sampleY * samplesPerRow + sampleX;
        const grayVal = graySamples[index];

        // Check if dark enough (adjustable threshold)
        if (grayVal < 60) {
          // Check if it's a local minimum in the 3x3 neighborhood
          let isMin = true;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dy === 0 && dx === 0) continue;
              const ny = sampleY + dy;
              const nx = sampleX + dx;
              if (ny >= 0 && ny < samplesPerCol && nx >= 0 && nx < samplesPerRow) {
                const nindex = ny * samplesPerRow + nx;
                if (graySamples[nindex] < grayVal) {
                  isMin = false;
                  break;
                }
              }
            }
            if (!isMin) break;
          }
          if (isMin) {
            eyeCandidates++;
            if (sampleX < minEyeX) minEyeX = sampleX;
            if (sampleX > maxEyeX) maxEyeX = sampleX;
          }
        }
      }
    }

    // Now, check if we have at least two eyes and they are sufficiently apart
    const eyeSeparation = maxEyeX - minEyeX;
    const minSeparation = samplesPerRow * 0.2; // at least 20% of the width in sample units

    if (eyeCandidates < 2 || eyeSeparation < minSeparation) {
      blockingIssues.push('Could not detect two eyes. Please position your face so that both eyes are visible.');
    }

    if (brightness < 55) tips.push('add a little more light');
    if (brightness > 220) tips.push('reduce glare');
    if (contrast < 18) tips.push('use a plainer background');
    if (sharpness < 4) tips.push('hold the camera steady');

    const brightnessScore = brightness > 45 && brightness < 225 ? 40 : 24;
    const contrastScore = Math.min(35, contrast * 1.4);
    const sharpnessScore = Math.min(25, sharpness * 3.5);
    const score = Math.round(Math.min(100, brightnessScore + contrastScore + sharpnessScore));

    if (blockingIssues.length > 0) {
      return {
        ok: false,
        score,
        message: `Capture rejected: ${blockingIssues.join(', ')}. Face the camera and retake in steady light.`,
      };
    }

    if (score < MIN_CAPTURE_SCORE) {
      return {
        ok: false,
        score,
        message: `Capture rejected (${score}%). Minimum accepted quality is ${MIN_CAPTURE_SCORE}%. Retake in better light and keep the camera steady.`,
      };
    }

    return {
      ok: true,
      score,
      message: tips.length > 0
        ? `Capture accepted (${score}%). Tip: ${tips.join(', ')}.`
        : `Capture accepted (${score}%). Face and background look clear enough for registration.`,
    };
}

function PrintModal({ onClose, onSuccess, students, filterInfo }: { onClose: () => void; onSuccess: () => void; students: RegisteredStudent[]; filterInfo: string }) {
   const [pin, setPin] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');

  const verify = async () => {
    const access = await readAdminPrintAccess();
    if (!access) {
      setErr('No active admin print PIN. Ask your lecturer to generate the admin print PIN first.');
      setPin('');
      return;
    }

    if (pin === access.pin) {
      generateStudentRegistryPDF({
        title: 'UniAttend Student Registry',
        subtitle: 'Official Registered Student List',
        totalStudents: students.length,
        filterInfo,
        students,
        generatedAt: new Date().toLocaleString(),
      });
      onSuccess();
      onClose();
    } else { setErr('Incorrect or expired admin print PIN. Ask your lecturer for the current admin print PIN.'); setPin(''); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="bg-white rounded-3xl p-8 w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center">
              <Lock className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-black text-slate-900">Print Registry</h3>
              <p className="text-xs text-slate-400">Enter admin print PIN from Lecturer Dashboard</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-xl">
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>
        <div className="mb-5">
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Admin Print PIN</label>
          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              value={pin}
              onChange={e => { setPin(e.target.value); setErr(''); }}
              onKeyDown={e => e.key === 'Enter' && verify()}
              className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-mono tracking-widest text-xl"
              placeholder="·····"
              autoFocus
            />
            <button onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
              {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {err && <p className="text-red-500 text-xs mt-2 font-semibold">{err}</p>}
        </div>
        <button onClick={verify} disabled={!pin}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-bold transition-all active:scale-95 disabled:opacity-40">
          Verify &amp; Print
        </button>
      </motion.div>
    </div>
  );
}

function DeleteStudentModal({ student, onClose, onDelete }: { student: RegisteredStudent; onClose: () => void; onDelete: (id: string) => Promise<void> }) {
  const [pin, setPin] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [deleting, setDeleting] = useState(false);

  const verify = async () => {
    if (deleting) return;
    const access = await readAdminPrintAccess();
    if (!access) {
      setErr('No active admin print PIN. Ask your lecturer to generate the admin print PIN first.');
      setPin('');
      return;
    }

    if (pin !== access.pin) {
      setErr('Incorrect or expired admin print PIN. Ask your lecturer for the current admin print PIN.');
      setPin('');
      return;
    }

    setDeleting(true);
    try {
      await onDelete(student.id);
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="bg-white rounded-3xl p-8 w-full max-w-sm shadow-2xl">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center">
              <Trash2 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-black text-slate-900">Delete Student</h3>
              <p className="text-xs text-slate-400">Verify with the lecturer dashboard PIN</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-xl" disabled={deleting}>
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        <div className="mb-5 rounded-xl border border-red-100 bg-red-50 p-3">
          <p className="text-xs font-semibold text-red-700">
            This will permanently remove {student.name} ({student.regNumber}) from the registry.
          </p>
        </div>

        <div className="mb-5">
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Admin Print PIN</label>
          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              value={pin}
              onChange={e => { setPin(e.target.value); setErr(''); }}
              onKeyDown={e => e.key === 'Enter' && verify()}
              className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 font-mono tracking-widest text-xl"
              placeholder="....."
              autoFocus
              disabled={deleting}
            />
            <button onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" disabled={deleting}>
              {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {err && <p className="text-red-500 text-xs mt-2 font-semibold">{err}</p>}
        </div>

        <button onClick={verify} disabled={!pin || deleting}
          className="w-full bg-red-600 hover:bg-red-700 text-white py-3 rounded-xl font-bold transition-all active:scale-95 disabled:opacity-40">
          {deleting ? 'Deleting...' : 'Verify & Delete'}
        </button>
      </motion.div>
    </div>
  );
}

export default function AdminPortal() {
  const [form, setForm] = useState({ name: '', regNumber: '', faculty: '', department: '', level: '' });
  const [students, setStudents] = useState<RegisteredStudent[]>([]);
  const [query, setQuery] = useState('');
  const [facultyFilter, setFacultyFilter] = useState('all');
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [showPrint, setShowPrint] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [quality, setQuality] = useState<CaptureQuality | null>(null);
  const [studentToDelete, setStudentToDelete] = useState<RegisteredStudent | null>(null);
  const [faceDescriptor, setFaceDescriptor] = useState<number[] | null>(null);
  const [captureLoading, setCaptureLoading] = useState(false);

  // Camera
  const [cameraOn, setCameraOn] = useState(false);
  const [captured, setCaptured] = useState<string | null>(null);
  const [camErr, setCamErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Load students
  useEffect(() => {
    let alive = true;
    readStudents().then(list => {
      if (alive) setStudents(list);
    });
    return () => { alive = false; };
  }, []);

  const persist = useCallback(async (student: RegisteredStudent) => {
    await saveStudent(student);
    setStudents(await readStudents());
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await deleteStudent(id);
    setStudents(await readStudents());
  }, []);

  // Camera controls
  const startCamera = useCallback(async () => {
    setCamErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
      setCameraOn(true);
      setCaptured(null);
      setQuality(null);
      setFaceDescriptor(null);
    } catch (e: unknown) {
      const msg = e instanceof Error && e.name === 'NotAllowedError'
        ? 'Camera permission denied. Please allow camera access in your browser.'
        : 'Could not access camera.';
      setCamErr(msg);
    }
  }, []);

  const capture = useCallback(async () => {
    if (captureLoading) return;
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    c.width = v.videoWidth || 640; c.height = v.videoHeight || 480;
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    const nextQuality = analyzeCaptureQuality(c);
    setQuality(nextQuality);
    setFaceDescriptor(null);
    if (!nextQuality.ok) {
      setCamErr(nextQuality.message);
      return;
    }

    setCaptureLoading(true);
    let faces;
    try {
      faces = await detectFaceDescriptors(c);
    } catch {
      setCamErr('Could not scan the face print. Check your connection and retake the capture.');
      setCaptureLoading(false);
      return;
    }

    if (faces.length === 0) {
      setCamErr('Capture rejected: no face was detected. Retake with one student facing the camera.');
      setCaptureLoading(false);
      return;
    }

    if (faces.length > 1) {
      setCamErr('Capture rejected: more than one face was detected. Only one student can appear in the registration photo.');
      setCaptureLoading(false);
      return;
    }

    setCamErr(null);
    setFaceDescriptor(faces[0].descriptor);
    setCaptured(c.toDataURL('image/jpeg', 0.85));
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCameraOn(false);
    setCaptureLoading(false);
  }, [captureLoading]);

  const retake = useCallback(() => { setCaptured(null); setQuality(null); setFaceDescriptor(null); startCamera(); }, [startCamera]);

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()); }, []);

  // Register
  const register = async () => {
    setFormError(null);
    const normalizedForm = normalizeStudentRecord({
      regNumber: form.regNumber,
      faculty: form.faculty,
      department: form.department,
      level: form.level,
    });
    const studentName = form.name.trim().replace(/\s+/g, ' ');

    if (!studentName) return setFormError('Full name is required.');
    if (!normalizedForm.regNumber) return setFormError('Registration number is required.');
    if (!normalizedForm.faculty) return setFormError('Faculty is required.');
    if (!normalizedForm.department) return setFormError('Department is required.');
    if (!normalizedForm.level) return setFormError('Level is required.');
    if (!captured) return setFormError('Please capture a clear student face print.');
    if (!quality?.ok) return setFormError('Please retake the face print with a clear face and background.');
    if (quality.score < MIN_CAPTURE_SCORE) return setFormError(`Please retake the face print. Capture quality must be at least ${MIN_CAPTURE_SCORE}%.`);
    if (!faceDescriptor) return setFormError('Please retake the face print so the biometric record can be saved.');
    if (students.some(s => normalizeRegNumber(s.regNumber) === normalizedForm.regNumber))
      return setFormError('A student with this registration number already exists.');

    const s: RegisteredStudent = {
      id: crypto.randomUUID(),
      name: studentName,
      regNumber: normalizedForm.regNumber,
      faculty: normalizedForm.faculty,
      department: normalizedForm.department,
      level: normalizedForm.level,
      faceImage: captured, faceDescriptor, registeredAt: new Date().toISOString(),
    };
    await persist(s);
    setForm({ name: '', regNumber: '', faculty: '', department: '', level: '' });
    setCaptured(null);
    setQuality(null);
    setFaceDescriptor(null);
    setSuccess(`${s.name} registered successfully!`);
    setTimeout(() => setSuccess(null), 4000);
    setPage(1);
  };

  // Filtered & paginated
  const updateQuery = (value: string) => {
    setQuery(value);
    setPage(1);
  };

  const faculties = Array.from(new Set(students.map(s => normalizeAcademicText(s.faculty)))).sort();
  const departments = Array.from(new Set(students
    .filter(s => facultyFilter === 'all' || normalizeAcademicText(s.faculty) === facultyFilter)
    .map(s => normalizeAcademicText(s.department))
  )).sort();
  const levels = Array.from(new Set([...LEVEL_OPTIONS, ...students.map(s => normalizeLevel(s.level))])).sort();

  const filtered = students.filter(s =>
    `${s.name} ${s.regNumber} ${s.department} ${s.faculty} ${s.level}`.toLowerCase().includes(query.toLowerCase()) &&
    (facultyFilter === 'all' || normalizeAcademicText(s.faculty) === facultyFilter) &&
    (departmentFilter === 'all' || normalizeAcademicText(s.department) === departmentFilter) &&
    (levelFilter === 'all' || normalizeLevel(s.level) === levelFilter)
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const shown = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const initials = (name: string) => name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();

  return (
    <>
      {showPrint && <PrintModal onClose={() => setShowPrint(false)} onSuccess={() => {}} students={filtered} filterInfo={`${facultyFilter === 'all' ? 'All Faculties' : facultyFilter} / ${departmentFilter === 'all' ? 'All Departments' : departmentFilter}${levelFilter === 'all' ? '' : ' / Level ' + levelFilter}`} />}
      {studentToDelete && <DeleteStudentModal student={studentToDelete} onClose={() => setStudentToDelete(null)} onDelete={handleDelete} />}

      {/* ── Screen Layout ── */}
      <div className="min-h-screen bg-[#f8fafc] no-print">
        {/* Header */}
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-40">
          <div className="flex items-center gap-3">
            <Link href="/" className="p-2 hover:bg-slate-100 rounded-xl transition-colors">
              <ChevronLeft className="w-5 h-5 text-slate-500" />
            </Link>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <ShieldCheck className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="font-black text-slate-900 text-sm leading-none">UniAttend</p>
                <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">Admin Portal</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
            <span className="font-bold text-emerald-600">{students.length} Registered</span>
          </div>
        </header>

        <div className="max-w-7xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-5 gap-8">

          {/* ── Registration Form ── */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-7 sticky top-24">
              <h2 className="text-lg font-black text-slate-900 mb-1">Register New Student</h2>
              <p className="text-xs text-slate-400 mb-6">Fill all fields and capture a face print.</p>

              <AnimatePresence>
                {formError && (
                  <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    className="flex gap-2 p-3 bg-red-50 border border-red-100 rounded-xl text-red-600 text-xs font-semibold mb-4">
                    <X className="w-4 h-4 flex-shrink-0 mt-0.5" />{formError}
                  </motion.div>
                )}
                {success && (
                  <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    className="flex gap-2 p-3 bg-emerald-50 border border-emerald-100 rounded-xl text-emerald-700 text-xs font-semibold mb-4">
                    <ShieldCheck className="w-4 h-4 flex-shrink-0 mt-0.5" />{success}
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="space-y-4">
                {[
                  { label: 'Full Name', key: 'name', placeholder: 'e.g. John Doe', mono: false },
                  { label: 'Reg Number', key: 'regNumber', placeholder: 'e.g. 24/SC/CO/001', mono: true },
                ].map(f => (
                  <div key={f.key}>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">{f.label}</label>
                    <input type="text" value={form[f.key as keyof typeof form]}
                      onChange={e => setForm(p => ({
                        ...p,
                        [f.key]: f.key === 'regNumber' ? normalizeRegNumber(e.target.value) : e.target.value,
                      }))}
                      className={`w-full px-4 py-3 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-sm ${f.mono ? 'font-mono' : ''}`}
                      placeholder={f.placeholder} />
                  </div>
                ))}

                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Faculty', key: 'faculty', placeholder: 'e.g. Computing' },
                    { label: 'Department', key: 'department', placeholder: 'e.g. Cyber Security' },
                  ].map(f => (
                    <div key={f.key}>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">{f.label}</label>
                      <input type="text" value={form[f.key as keyof typeof form]}
                        onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                        onBlur={e => setForm(p => ({ ...p, [f.key]: normalizeAcademicText(e.target.value) }))}
                        className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-sm"
                        placeholder={f.placeholder} />
                    </div>
                  ))}
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Level</label>
                  <select
                    value={form.level}
                    onChange={e => setForm(p => ({ ...p, level: normalizeLevel(e.target.value) }))}
                    className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-sm"
                  >
                    <option value="">Select level</option>
                    {LEVEL_OPTIONS.map(level => <option key={level} value={level}>{level}</option>)}
                  </select>
                </div>

                {/* Webcam */}
                <div className="pt-4 border-t border-slate-100">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                    <p className="text-xs font-black text-slate-900 uppercase tracking-widest">Face Print Capture</p>
                  </div>

                  <div className="relative bg-slate-900 rounded-2xl overflow-hidden" style={{ aspectRatio: '4/3' }}>
                    <canvas ref={canvasRef} className="hidden" />
                    <video ref={videoRef} autoPlay playsInline muted
                      className={`w-full h-full object-cover ${cameraOn ? '' : 'hidden'}`} />

                    {captured && !cameraOn && (
                      <Image src={captured} alt="Face capture" fill unoptimized className="object-cover" />
                    )}

                    {!cameraOn && !captured && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                        <Camera className="w-10 h-10 text-slate-600 opacity-30" />
                        <p className="text-slate-600 text-xs opacity-40">Camera inactive</p>
                      </div>
                    )}

                    {(cameraOn || captured) && (
                      <div className="absolute inset-3 pointer-events-none">
                        {['top-0 left-0 border-t-2 border-l-2 rounded-tl-lg',
                          'top-0 right-0 border-t-2 border-r-2 rounded-tr-lg',
                          'bottom-0 left-0 border-b-2 border-l-2 rounded-bl-lg',
                          'bottom-0 right-0 border-b-2 border-r-2 rounded-br-lg',
                        ].map((cls, i) => <span key={i} className={`absolute w-6 h-6 border-blue-400 ${cls}`} />)}
                      </div>
                    )}

                    {captured && (
                      <div className="absolute top-3 right-3 bg-emerald-500 text-white text-[10px] font-black px-2 py-1 rounded-lg flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3" /> Captured
                      </div>
                    )}
                  </div>

                  {camErr && <p className="text-red-500 text-xs mt-2 font-semibold">{camErr}</p>}
                  {quality?.ok && <p className="text-emerald-600 text-xs mt-2 font-bold">{quality.message}</p>}

                  <div className="flex gap-2 mt-3">
                    {!cameraOn && !captured && (
                      <button onClick={startCamera}
                        className="flex-1 flex items-center justify-center gap-2 py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-bold text-sm transition-all active:scale-95">
                        <Camera className="w-4 h-4" /> Start Camera
                      </button>
                    )}
                    {cameraOn && (
                      <button onClick={capture}
                        disabled={captureLoading}
                        className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-sm transition-all active:scale-95 disabled:opacity-50">
                        {captureLoading ? <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"></div> : <Camera className="w-4 h-4" />}
                        {captureLoading ? 'Scanning...' : 'Capture'}
                      </button>
                    )}
                    {captured && (
                      <button onClick={retake}
                        className="flex-1 flex items-center justify-center gap-2 py-3 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-xl font-bold text-sm transition-all active:scale-95">
                        <RefreshCw className="w-4 h-4" /> Retake
                      </button>
                    )}
                  </div>
                </div>

                <button onClick={register}
                  className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-sm transition-all active:scale-95 shadow-lg shadow-blue-500/20">
                  Register Student
                </button>
              </div>
            </div>
          </div>

          {/* ── Student List ── */}
          <div className="lg:col-span-3 flex flex-col gap-4">
            {/* Toolbar */}
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_auto_auto_auto_auto]">
              <div className="relative flex-1">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input type="text" value={query} onChange={e => updateQuery(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-sm"
                  placeholder="Search by name, reg number, level…" />
              </div>
              <select
                value={facultyFilter}
                onChange={event => {
                  setFacultyFilter(event.target.value);
                  setDepartmentFilter('all');
                  setPage(1);
                }}
                className="px-4 py-3 bg-white border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-bold text-slate-700"
              >
                <option value="all">All Faculties</option>
                {faculties.map(faculty => <option key={faculty} value={faculty}>{faculty}</option>)}
              </select>
              <select
                value={departmentFilter}
                onChange={event => {
                  setDepartmentFilter(event.target.value);
                  setPage(1);
                }}
                className="px-4 py-3 bg-white border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-bold text-slate-700"
              >
                <option value="all">All Departments</option>
                {departments.map(department => <option key={department} value={department}>{department}</option>)}
              </select>
              <select
                value={levelFilter}
                onChange={event => {
                  setLevelFilter(event.target.value);
                  setPage(1);
                }}
                className="px-4 py-3 bg-white border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-bold text-slate-700"
              >
                <option value="all">All Levels</option>
                {levels.map(lvl => <option key={lvl} value={lvl}>{lvl}</option>)}
              </select>
              <button onClick={() => setShowPrint(true)}
                className="flex items-center gap-2 px-5 py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-bold text-sm transition-all active:scale-95 whitespace-nowrap">
                <Printer className="w-4 h-4" /> Print PDF
              </button>
            </div>

            {/* Table */}
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <p className="text-sm font-black text-slate-900">Student Registry</p>
                <p className="text-xs text-slate-400">{filtered.length} student{filtered.length !== 1 ? 's' : ''}</p>
              </div>

              {shown.length === 0 ? (
                <div className="py-20 text-center text-slate-400">
                  <Camera className="w-10 h-10 mx-auto mb-3 opacity-20" />
                  <p className="text-sm font-semibold">{query ? 'No students match your search.' : 'No students registered yet.'}</p>
                </div>
              ) : (
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="bg-slate-50/70 border-b border-slate-100">
                      <th className="px-6 py-3 text-xs font-black text-slate-500 uppercase tracking-widest">Student</th>
                      <th className="px-6 py-3 text-xs font-black text-slate-500 uppercase tracking-widest">Reg No</th>
                      <th className="px-6 py-3 text-xs font-black text-slate-500 uppercase tracking-widest">Dept</th>
                      <th className="px-6 py-3 text-xs font-black text-slate-500 uppercase tracking-widest">Level</th>
                      <th className="px-6 py-3 text-xs font-black text-slate-500 uppercase tracking-widest">Face</th>
                      <th className="px-6 py-3 text-xs font-black text-slate-500 uppercase tracking-widest">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shown.map((s, i) => (
                      <motion.tr key={s.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.04 }} className="hover:bg-slate-50/60 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            {s.faceImage ? (
                              <Image
                                src={s.faceImage}
                                alt={s.name}
                                width={36}
                                height={36}
                                unoptimized
                                className="w-9 h-9 rounded-full object-cover border-2 border-slate-200"
                              />
                            ) : (
                              <div className="w-9 h-9 bg-gradient-to-br from-blue-500 to-blue-700 rounded-full flex items-center justify-center text-white text-xs font-black">
                                {initials(s.name)}
                              </div>
                            )}
                            <span className="font-bold text-slate-900">{s.name}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-slate-500">{s.regNumber}</td>
                        <td className="px-6 py-4">
                          <span className="px-2.5 py-1 bg-slate-100 rounded-lg text-xs font-bold text-slate-600">{s.department}</span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="px-2.5 py-1 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-bold">{s.level}</span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-1.5 text-emerald-600 text-xs font-black">
                            <ShieldCheck className="w-4 h-4" /> Saved
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-1">
                            <button onClick={() => setStudentToDelete(s)}
                              className="text-red-400 hover:text-red-600 transition-colors p-1"
                              title="Delete student">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* Pagination */}
              {pages > 1 && (
                <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between">
                  <p className="text-xs text-slate-400">
                    Page {page} of {pages} · {filtered.length} total
                  </p>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                      className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-30 transition-all">
                      <ChevronLeft className="w-4 h-4 text-slate-600" />
                    </button>
                    {Array.from({ length: pages }, (_, i) => i + 1).map(n => (
                      <button key={n} onClick={() => setPage(n)}
                        className={`w-8 h-8 rounded-lg text-xs font-bold transition-all ${n === page ? 'bg-blue-600 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                        {n}
                      </button>
                    ))}
                    <button onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page === pages}
                      className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-30 transition-all">
                      <ChevronRight className="w-4 h-4 text-slate-600" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
