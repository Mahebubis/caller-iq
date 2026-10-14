/*
 * Formatting shared by every screen. These used to be copied into each file with small
 * differences ("5m ago" on one tab, "5 min ago" on another).
 */

/** The panel writes times in India time without a zone. */
export const serverTime = (s: string | null | undefined): number => {
  if (!s) return 0;
  const t = Date.parse(String(s).replace(' ', 'T') + '+05:30');
  return isNaN(t) ? 0 : t;
};

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a date. */
export const ago = (ms: number, never = ''): string => {
  if (!ms) return never;
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)} d ago`;
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const dateTime = (ms: number): string =>
  ms ? new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';

export const dateOnly = (ms: number): string =>
  ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/** Talk time in words: "1h 4m", "4m 12s", "38s". */
export const talk = (sec: number | null | undefined): string => {
  const t = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
};

/** Same as the dashboard: '45s' under a minute, '02:04' from a minute, '1:02:04' from an hour. */
export const clock = (seconds: number): string => {
  const t = Math.max(0, Math.round(Number(seconds) || 0));
  if (t < 60) return `${t}s`;
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const r = t % 60;
  return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
};

/** "Today, 10:42 am" / "Yesterday, 6:05 pm" / "12 Oct, 9:00 am". */
export const callTime = (ms: number): string => {
  if (!ms || isNaN(ms)) return 'Recently';
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const same = (a: Date, b: Date) => a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  if (same(d, today)) return `Today, ${time}`;
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (same(d, y)) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${time}`;
};

export const last10 = (n: string | null | undefined) => (n || '').replace(/\D/g, '').slice(-10);

/** A 10-digit Indian number as "+91 98765 43210"; anything else as given. */
export const prettyPhone = (n: string | null | undefined): string => {
  const s = (n || '').trim();
  const d = s.replace(/\D/g, '');
  const ten = d.length === 10 ? d : d.length === 12 && d.startsWith('91') ? d.slice(2) : '';
  return ten ? `+91 ${ten.slice(0, 5)} ${ten.slice(5)}` : s;
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

export const num = (n: number | null | undefined) => (Number(n) || 0).toLocaleString('en-IN');

const clockTime = (d: Date) => d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

/** A callback time in words: "Today, 4:30 pm", "Tomorrow, 10:00 am", "Wed 15 Oct, 4:30 pm". */
export const callbackTime = (ms: number): string => {
  if (!ms) return '';
  const d = new Date(ms);
  const day = new Date(ms).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  const label = day === today ? 'Today' : day === today + 86400000 ? 'Tomorrow'
    : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${label}, ${clockTime(d)}`;
};

/** How far off a callback time is: "in 25 min", "due now", "12 min overdue". */
export const dueIn = (ms: number): string => {
  const min = Math.round((ms - Date.now()) / 60000);
  if (Math.abs(min) < 1) return 'due now';
  const span = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${Math.floor(m / 1440)} d`);
  return min > 0 ? `in ${span(min)}` : `${span(-min)} overdue`;
};
