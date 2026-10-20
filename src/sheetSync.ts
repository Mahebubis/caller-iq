import { NativeModules } from 'react-native';
import Papa from 'papaparse';
import { scrubPhone } from './crm';

const { CallBridge } = NativeModules;

/*
 * Google Sheets → calling list, without any Google API or key: a sheet shared as "anyone with the
 * link can view" (or published) can be read as CSV. A list linked to a sheet is checked every two
 * minutes while the app is open; rows with a number the list has not seen are added to it
 * (imports.php chunk with append: the panel skips any number the list already has).
 */

export type Field4 = 'phone' | 'name' | 'email' | 'status' | 'time';
export type ColMap = { [k in Field4]: number };

export interface SheetLink {
  listId: number;
  listName: string;
  url: string;              // as pasted
  map: { [k in Field4]?: string };   // column headers, so a reordered sheet still maps
  defStatus: string;
  seen: string[];           // numbers (10 digits) already sent to the list
  lastAt: number;
  lastAdded: number;
  error: string;
}

export const CACHE_SHEETS = 'sheet_links_v1';
export const SYNC_EVERY_MS = 2 * 60 * 1000;

/** A Google Sheets link of any kind → its CSV export; other links are used as they are. */
export const sheetCsvUrl = (raw: string): string => {
  const u = raw.trim();
  const m = u.match(/docs\.google\.com\/spreadsheets\/d\/(e\/)?([a-zA-Z0-9_-]+)/);
  if (!m) return u;
  if (/output=csv|format=csv/.test(u)) return u;
  const gid = (u.match(/[#&?]gid=(\d+)/) || [])[1];
  if (m[1]) return `https://docs.google.com/spreadsheets/d/e/${m[2]}/pub?output=csv${gid ? `&gid=${gid}` : ''}`;
  return `https://docs.google.com/spreadsheets/d/${m[2]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
};

export const fetchCsv = async (raw: string): Promise<string> => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(sheetCsvUrl(raw), { signal: ctl.signal, headers: { Accept: 'text/csv,text/plain,*/*' } });
    const text = await res.text();
    if (!res.ok) throw new Error(`The sheet answered HTTP ${res.status}`);
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('That link opens a sign-in page — share the sheet as “Anyone with the link can view”, or File → Share → Publish to web → CSV.');
    return text.replace(/^﻿/, '');
  } catch (e: any) {
    throw new Error(e?.name === 'AbortError' ? 'The sheet took too long to load' : e?.message || String(e));
  } finally {
    clearTimeout(timer);
  }
};

export const parseTable = (text: string): { headers: string[]; rows: string[][] } => {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  const all = (parsed.data || []).filter((r) => Array.isArray(r) && r.some((c) => String(c).trim()));
  if (all.length < 1) return { headers: [], rows: [] };
  const headers = all[0].map((h, i) => String(h || '').trim() || `Column ${i + 1}`);
  return { headers, rows: all.slice(1).map((r) => headers.map((_, i) => String(r[i] ?? '').trim())) };
};

/** "2026-10-15 14:32", "15/10/2026 2:32 PM", "14:32"… → a timestamp (when there is a date) and the hour. */
export const parseLeadTime = (raw: string): { t: string; h: number | null } => {
  const v = String(raw || '').trim();
  if (!v) return { t: '', h: null };
  const tm = v.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  let h: number | null = null;
  let mi = 0;
  if (tm) {
    h = Number(tm[1]) % 24;
    mi = Number(tm[2]);
    const ap = (tm[4] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  let date = '';
  const iso = v.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  const dmy = v.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (iso) date = `${iso[1]}-${pad(+iso[2])}-${pad(+iso[3])}`;
  else if (dmy) {
    const y = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    date = `${y}-${pad(+dmy[2])}-${pad(+dmy[1])}`;    // day first, as Indian files write it
  }
  return { t: date ? `${date} ${pad(h ?? 0)}:${pad(mi)}:00` : '', h };
};

/** One file row → what imports.php "chunk" takes. `rowNo` is its line in the file. */
export const chunkRow = (r: string[], map: ColMap, rowNo: number) => {
  const scrub = scrubPhone(r[map.phone]);
  const lt = map.time >= 0 ? parseLeadTime(r[map.time]) : { t: '', h: null };
  return {
    r: rowNo,
    // A clean number goes in cleaned; anything else as written, so it shows as "Needs review".
    p: scrub.ok ? scrub.digits : r[map.phone],
    e: map.email >= 0 ? r[map.email] : '',
    n: map.name >= 0 ? r[map.name] : '',
    s: map.status >= 0 ? r[map.status] : '',
    t: lt.t,
    h: lt.h ?? '',
    d: r,
  };
};

export const mapByNames = (headers: string[], names: SheetLink['map']): ColMap => {
  const at = (k: Field4) => (names[k] ? headers.indexOf(names[k]!) : -1);
  return { phone: at('phone'), name: at('name'), email: at('email'), status: at('status'), time: at('time') };
};

export const loadLinks = async (): Promise<SheetLink[]> => {
  try {
    const raw = await CallBridge?.loadUiCache?.(CACHE_SHEETS);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
};
export const saveLinks = (links: SheetLink[]) => CallBridge?.saveUiCache?.(CACHE_SHEETS, JSON.stringify(links));

/**
 * One sync: the sheet's rows with a number this list has not seen yet go to the list. Returns the
 * link updated (seen numbers, when, how many were added, or the error).
 */
export const syncLink = async (link: SheetLink, ask: (body: any, ms?: number) => Promise<any>): Promise<SheetLink> => {
  try {
    const { headers, rows } = parseTable(await fetchCsv(link.url));
    const map = mapByNames(headers, link.map);
    if (map.phone < 0) throw new Error(`The sheet has no “${link.map.phone}” column any more`);
    const seen = new Set(link.seen);
    const fresh: ReturnType<typeof chunkRow>[] = [];
    rows.forEach((r, i) => {
      const p = scrubPhone(r[map.phone]);
      const key = p.ok ? p.digits : r[map.phone];
      if (!key || seen.has(key)) return;
      seen.add(key);
      fresh.push(chunkRow(r, map, i + 1));
    });
    let added = 0;
    for (let i = 0; i < fresh.length; i += 1000) {
      const d = await ask({ action: 'chunk', id: link.listId, append: true, rows: fresh.slice(i, i + 1000) }, 120000);
      added += Number(d.stored) || 0;
    }
    if (fresh.length) await ask({ action: 'finish', id: link.listId }, 120000);
    return { ...link, seen: [...seen], lastAt: Date.now(), lastAdded: added, error: '' };
  } catch (e: any) {
    return { ...link, lastAt: Date.now(), error: e?.message || String(e) };
  }
};
