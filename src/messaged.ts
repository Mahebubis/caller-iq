import { useEffect, useState } from 'react';
import { NativeModules } from 'react-native';

const { CallBridge } = NativeModules;

/*
 * Who this phone has sent an SMS or a WhatsApp, and when (by the number's last 10 digits). A
 * message counts as handling a callback, so Callbacks drops the person straight away — before the
 * panel has the message logged. Kept on the phone for a week.
 */

const CACHE = 'messaged_v1';
const KEEP_MS = 7 * 24 * 3600 * 1000;
let map: { [k: string]: number } = {};
const listeners = new Set<() => void>();
const last10 = (n: string) => (n || '').replace(/\D/g, '').slice(-10);

CallBridge?.loadUiCache?.(CACHE).then((raw: string) => {
  try {
    const saved = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    map = Object.fromEntries(Object.entries(saved).filter(([, at]) => now - Number(at) < KEEP_MS)) as { [k: string]: number };
    listeners.forEach((l) => l());
  } catch (_) {}
}).catch(() => {});

export const markMessaged = (numbers: string | string[]) => {
  const at = Date.now();
  (Array.isArray(numbers) ? numbers : [numbers]).forEach((n) => { const k = last10(n); if (k) map[k] = at; });
  CallBridge?.saveUiCache?.(CACHE, JSON.stringify(map));
  listeners.forEach((l) => l());
};

export const messagedAt = (number: string) => map[last10(number)] || 0;

/** Re-renders when someone is messaged. */
export const useMessaged = () => {
  const [, setV] = useState(0);
  useEffect(() => {
    const l = () => setV((v) => v + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return messagedAt;
};
