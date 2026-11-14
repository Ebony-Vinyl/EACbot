// A picture the person chose for the app's ground, kept in this browser. It is shrunk and re-encoded before it is
// stored, so a phone photo never lands in the database at full size; the object URL the renderer uses is derived from
// the stored blob and revoked when it is replaced.

import { useSyncExternalStore } from "react";

const DB_NAME = "eacbot-background";
const DB_VERSION = 1;
const STORE = "pictures";
const RECORD_KEY = "app-background";
const MAX_SIDE = 2560;
const QUALITIES = [0.9, 0.82, 0.74, 0.66];
const MAX_BYTES = 3 * 1024 * 1024;

export type PictureProblem = "format" | "read" | "size" | "failed";

type Stored = { blob: Blob; width: number; height: number; addedAt: number };

const listeners = new Set<() => void>();
let current: { url: string; width: number; height: number } | null = null;
let loaded = false;
let loading: Promise<void> | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no indexedDB"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("open failed"));
  });
}

function readRecord(): Promise<Stored | null> {
  return openDatabase().then(
    (db) =>
      new Promise<Stored | null>((resolve, reject) => {
        const request = db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD_KEY);
        request.onsuccess = () => {
          const value = request.result as Stored | undefined;
          resolve(value && value.blob instanceof Blob ? value : null);
        };
        request.onerror = () => reject(request.error ?? new Error("read failed"));
      }).finally(() => db.close()),
  );
}

function writeRecord(record: Stored | null): Promise<void> {
  return openDatabase().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        if (record) store.put(record, RECORD_KEY);
        else store.delete(RECORD_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("write failed"));
      }).finally(() => db.close()),
  );
}

function adopt(record: Stored | null): void {
  if (current) URL.revokeObjectURL(current.url);
  current = record ? { url: URL.createObjectURL(record.blob), width: record.width, height: record.height } : null;
  notify();
}

/** Loads what was stored, once. Safe to call before the first render. */
export function loadStoredPicture(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  loading = readRecord()
    .then((record) => adopt(record))
    .catch(() => adopt(null))
    .finally(() => {
      loaded = true;
      loading = null;
    });
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void loadStoredPicture();
  // The picture can finish loading while nothing is subscribed (React's development double-mount unmounts between the
  // first and second subscribe), in which case `loaded` is already true and no notify would ever reach this listener.
  // Reading the snapshot once more after the current render settles is what gets the picture on screen.
  if (loaded) queueMicrotask(() => {
    if (listeners.has(listener)) listener();
  });
  return () => {
    listeners.delete(listener);
  };
}

/** The picture in use, as an object URL the app can put in CSS. Null when there is none. */
export function useBackgroundPicture(): { url: string; width: number; height: number } | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

export function backgroundPicture(): { url: string; width: number; height: number } | null {
  return current;
}

interface Drawn {
  width: number;
  height: number;
  close?(): void;
}

function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return {
    context: canvas.getContext("2d"),
    encode: (type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality)),
  };
}

/** The picture ready to keep: at most MAX_SIDE across, re-drawn as WebP under MAX_BYTES, or why it can't be. */
export async function preparePicture(file: Blob): Promise<{ ok: true; blob: Blob; width: number; height: number } | { ok: false; problem: PictureProblem }> {
  let picture: Drawn & CanvasImageSource;
  try {
    picture = await createImageBitmap(file);
  } catch {
    return { ok: false, problem: "read" };
  }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(1, picture.width), MAX_SIDE / Math.max(1, picture.height));
    const width = Math.max(1, Math.round(picture.width * scale));
    const height = Math.max(1, Math.round(picture.height * scale));
    for (const quality of QUALITIES) {
      const surface = canvasOf(width, height);
      if (!surface.context) return { ok: false, problem: "read" };
      surface.context.imageSmoothingQuality = "high";
      surface.context.drawImage(picture, 0, 0, width, height);
      const blob = await surface.encode("image/webp", quality);
      if (blob && blob.size <= MAX_BYTES) return { ok: true, blob, width, height };
    }
    return { ok: false, problem: "size" };
  } finally {
    picture.close?.();
  }
}

/** Keeps the prepared picture; the previous one is replaced. */
export async function saveBackgroundPicture(blob: Blob, width: number, height: number): Promise<{ ok: true } | { ok: false; problem: PictureProblem }> {
  const record: Stored = { blob, width, height, addedAt: Date.now() };
  try {
    await writeRecord(record);
  } catch {
    return { ok: false, problem: "failed" };
  }
  adopt(record);
  return { ok: true };
}

export async function clearBackgroundPicture(): Promise<void> {
  try {
    await writeRecord(null);
  } catch {}
  adopt(null);
}
