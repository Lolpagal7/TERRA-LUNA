import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, type User } from 'firebase/auth';
import {
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import type { Mode } from '@/types';

export interface SavedMission {
  mode: Mode;
  start: [number, number];
  goal: [number, number];
  env_intensity: number;
  noise_level: number;
}

const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || 'astra-gnc';
const apiKey = import.meta.env.VITE_FIREBASE_API_KEY?.trim();
const firebaseApp = apiKey
  ? (getApps().length ? getApp() : initializeApp({
      apiKey,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
      projectId,
      appId: import.meta.env.VITE_FIREBASE_APP_ID || undefined,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || undefined,
    }))
  : null;

const auth = firebaseApp ? getAuth(firebaseApp) : null;
const db = firebaseApp ? getFirestore(firebaseApp) : null;
let signInPromise: Promise<User> | null = null;

async function getAnonymousUser(): Promise<User | null> {
  if (!auth) return null;
  if (auth.currentUser) return auth.currentUser;
  signInPromise ??= signInAnonymously(auth).then(({ user }) => user).catch((error) => {
    signInPromise = null;
    throw error;
  });
  return signInPromise;
}

function isSavedMission(value: unknown): value is SavedMission {
  if (!value || typeof value !== 'object') return false;
  const mission = value as Partial<SavedMission>;
  return (mission.mode === 'earth' || mission.mode === 'moon') &&
    Array.isArray(mission.start) && mission.start.length === 2 &&
    mission.start.every(Number.isFinite) &&
    Array.isArray(mission.goal) && mission.goal.length === 2 &&
    mission.goal.every(Number.isFinite) &&
    Number.isFinite(mission.env_intensity) &&
    Number.isFinite(mission.noise_level);
}

export async function loadLatestMission(): Promise<SavedMission | null> {
  if (!db) return null;
  const user = await getAnonymousUser();
  if (!user) return null;
  const saved = await getDoc(doc(db, 'users', user.uid, 'missionState', 'current'));
  const mission: unknown = saved.data();
  return saved.exists() && isSavedMission(mission) ? mission : null;
}

export async function saveLatestMission(mission: SavedMission): Promise<void> {
  if (!db) return;
  const user = await getAnonymousUser();
  if (!user) return;
  await setDoc(doc(db, 'users', user.uid, 'missionState', 'current'), {
    ...mission,
    updatedAt: serverTimestamp(),
  });
}
