'use client';

const MODEL_URL = '/models';

export const FACE_MATCH_THRESHOLD = 0.56;

let modelsPromise: Promise<void> | null = null;
let faceApiPromise: Promise<typeof import('@vladmandic/face-api')> | null = null;

type FaceInput = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;

export interface FaceDescriptorResult {
  descriptor: number[];
  score: number;
}

export interface FaceAnalysisResult extends FaceDescriptorResult {
  landmarks: {
    leftEye: Array<{ x: number; y: number }>;
    rightEye: Array<{ x: number; y: number }>;
  };
}

function getFaceApi() {
  if (!faceApiPromise) {
    faceApiPromise = import('@vladmandic/face-api');
  }

  return faceApiPromise;
}

export function loadFaceModels() {
  if (!modelsPromise) {
    modelsPromise = getFaceApi().then(faceapi => Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ])).then(() => undefined);
  }

  return modelsPromise;
}

export async function detectFaceDescriptors(input: FaceInput): Promise<FaceDescriptorResult[]> {
  await loadFaceModels();
  const faceapi = await getFaceApi();
  const detections = await faceapi
    .detectAllFaces(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  return detections.map(item => ({
    descriptor: Array.from(item.descriptor),
    score: item.detection.score,
  }));
}

export async function detectFaceAnalyses(input: FaceInput): Promise<FaceAnalysisResult[]> {
  await loadFaceModels();
  const faceapi = await getFaceApi();
  const detections = await faceapi
    .detectAllFaces(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  return detections.map(item => ({
    descriptor: Array.from(item.descriptor),
    score: item.detection.score,
    landmarks: {
      leftEye: item.landmarks.getLeftEye().map(point => ({ x: point.x, y: point.y })),
      rightEye: item.landmarks.getRightEye().map(point => ({ x: point.x, y: point.y })),
    },
  }));
}

export function faceDistance(first: number[], second: number[]) {
  const length = Math.min(first.length, second.length);
  if (length === 0) return Number.POSITIVE_INFINITY;

  let total = 0;
  for (let index = 0; index < length; index += 1) {
    const diff = first[index] - second[index];
    total += diff * diff;
  }

  return Math.sqrt(total);
}

export function faceConfidence(distance: number) {
  return Math.max(0, Math.min(100, Math.round((1 - distance) * 100)));
}

export function imageFromDataUrl(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read the registered face image.'));
    image.src = dataUrl;
  });
}
