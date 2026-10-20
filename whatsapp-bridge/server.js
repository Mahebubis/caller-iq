/*
 * Caller IQ — WhatsApp bridge.
 *
 * Runs a WhatsApp Web session (whatsapp-web.js, in a headless Chrome) on this computer and lets
 * the Caller IQ app send messages through it in the background: one at a time after an unanswered
 * call or during one, a whole campaign to the people picked on a calling list (spaced out by a
 * random delay and a cooldown every batch), and reminders scheduled for later (an offer about to
 * expire). It also listens for replies: every incoming message goes to the app as an event, and
 * an opt-out ("STOP", "DND", "not interested") blocks that number from bulk sends from then on.
 *
 *   GET  /api/whatsapp/status?since=N&ev=M → { connected, phase, me, qrDataUrl, campaign, events, evSeq }
 *   POST /api/whatsapp/send-single      { phone, name?, segment?, message, mediaUrl? }
 *   POST /api/whatsapp/send-bulk        { contacts: [{ id, name, phone, segment }], template,
 *                                         minDelaySec?, maxDelaySec?, spin?, batchSize?, cooldownSec? }
 *   POST /api/whatsapp/campaign-control { action: 'pause' | 'resume' | 'cancel' }
 *   POST /api/whatsapp/schedule         { key, phone, name?, segment?, message, at, group? }  (at: ms)
 *   POST /api/whatsapp/schedule-cancel  { key } | { group }
 *   GET  /api/whatsapp/schedule?phone=  → what is still to be sent to a number
 *   POST /api/whatsapp/drip             { key, contacts: [...], steps: [{ afterMin, message }], gapSec? }
 *   POST /api/whatsapp/dial             { phone, name?, segment? }   → pushes a number to the phones
 *   GET  /dialer?key=                   the laptop page: click a number, the phone dials it
 *   GET  /m?key=                        the mobile dialer view: the last pushed number, 1 tap to call
 *
 * Media: send-single, send-bulk and schedule take `media: { b64, mime, name, voice? }` — a PDF,
 * an image or an audio file sent with the message as its caption (audio goes as a voice note when
 * voice is set). A drip is a group of scheduled messages per number ("drip:<digits>"); any reply
 * from that number cancels the rest of its drip.
 *   GET  /api/whatsapp/dnd              → { numbers: [...] }
 *   POST /api/whatsapp/dnd              { phone, dnd: true | false }
 *   POST /api/whatsapp/logout           → unlinks this computer; a new QR follows
 *
 * Events (replies, scheduled sends) carry a growing seq; the app asks for those after the last one
 * it handled (?ev=M) and logs them in the panel. The session is saved in ./.wwebjs_auth, DND
 * numbers, scheduled messages and recent events in ./data, so a restart loses none of them.
 * Set BRIDGE_KEY and every request must carry it (X-Bridge-Key header). See README.md.
 */
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const PORT = Number(process.env.PORT) || 3001;
const BRIDGE_KEY = process.env.BRIDGE_KEY || '';
const HEADLESS = process.env.HEADLESS !== 'false';
const COUNTRY = process.env.COUNTRY_CODE || '91';
const MAX_CONTACTS = 2000;
const RESULTS_KEPT = 5000;
const EVENTS_KEPT = 2000;
const DATA_DIR = path.join(__dirname, 'data');
const OPT_OUT = /\b(stop|dnd|unsubscribe|not\s+interested|no\s+interest)\b|मत\s*भेज|बंद\s*करो|नहीं\s*चाहिए/iu;

/* ── small JSON store ─────────────────────────────────────────────────────── */

fs.mkdirSync(DATA_DIR, { recursive: true });
const load = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch (_) { return fallback; }
};
const save = (name, value) => {
  const file = path.join(DATA_DIR, name);
  fs.writeFile(`${file}.tmp`, JSON.stringify(value), (e) => { if (!e) fs.rename(`${file}.tmp`, file, () => {}); });
};

const dnd = new Set(load('dnd.json', []));
const saveDnd = () => save('dnd.json', [...dnd]);
const store = load('events.json', { seq: 0, events: [] });
const pushEvent = (e) => {
  store.seq += 1;
  store.events.push({ seq: store.seq, at: Date.now(), ...e });
  if (store.events.length > EVENTS_KEPT) store.events.splice(0, store.events.length - EVENTS_KEPT);
  save('events.json', store);
};
let scheduled = load('scheduled.json', []);   // { key, phone, name, segment, message, at }
const saveScheduled = () => save('scheduled.json', scheduled);
/** Drops every scheduled message of a group; how many went. */
const cancelGroup = (group) => {
  const before = scheduled.length;
  scheduled = scheduled.filter((x) => x.group !== group);
  if (scheduled.length !== before) saveScheduled();
  return before - scheduled.length;
};
const dripGroup = (phone) => `drip:${toDigits(phone)}`;
/* Numbers pushed from a laptop to dial (newest first), for the mobile dialer view. */
const dials = [];

/* ── WhatsApp session ─────────────────────────────────────────────────────── */

const wa = { phase: 'starting', connected: false, qrDataUrl: null, me: '', error: '' };

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: HEADLESS,
    executablePath: process.env.CHROME_PATH || undefined,   // an installed Chrome / Edge instead of the downloaded one
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', async (qr) => {
  try {
    wa.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
  } catch (e) {
    wa.error = `QR: ${e.message}`;
  }
  wa.phase = 'qr';
  wa.connected = false;
  console.log('[wa] Scan the QR from the Caller IQ app (or open /api/whatsapp/qr in a browser).');
});
client.on('authenticated', () => { wa.phase = 'authenticated'; wa.qrDataUrl = null; });
client.on('auth_failure', (msg) => { wa.phase = 'qr'; wa.error = `Login failed: ${msg}`; console.error('[wa] auth failure', msg); });
client.on('ready', () => {
  wa.phase = 'ready';
  wa.connected = true;
  wa.qrDataUrl = null;
  wa.error = '';
  wa.me = client.info?.wid?.user || '';
  console.log(`[wa] Connected as ${wa.me}`);
});
client.on('disconnected', (reason) => {
  wa.phase = 'disconnected';
  wa.connected = false;
  wa.error = `Disconnected: ${reason}`;
  console.warn('[wa] disconnected', reason);
  if (campaign.running) campaign.paused = true;   // nothing can be sent until it reconnects
  setTimeout(() => client.initialize().catch((e) => { wa.error = e.message; }), 5000);
});

/* Replies: one person writing to us (not groups, status updates or channels). */
client.on('message', async (msg) => {
  try {
    if (msg.fromMe || !msg.from || /@(g\.us|broadcast|newsletter)$/.test(msg.from) || msg.from === 'status@broadcast') return;
    let phone = msg.from.replace(/@.*$/, '');
    if (msg.from.endsWith('@lid')) {
      // A "linked id" hides the number; the contact still knows it.
      const contact = await msg.getContact().catch(() => null);
      phone = (contact && contact.number) || '';
    }
    phone = phone.replace(/\D/g, '');
    if (!phone) return;
    const text = msg.body || (msg.hasMedia ? `[${msg.type}]` : '');
    const optOut = OPT_OUT.test(text);
    if (optOut && !dnd.has(phone)) { dnd.add(phone); saveDnd(); }
    // They answered: the rest of their follow-up drip is not needed any more.
    const dropped = cancelGroup(`drip:${phone}`);
    if (dropped) pushEvent({ type: 'drip_stop', phone, text: `Drip stopped — replied (${dropped} left unsent)` });
    pushEvent({ type: 'in', id: msg.id?._serialized || `${phone}-${msg.timestamp}`, phone, text: text.slice(0, 1000), optOut, msgAt: (msg.timestamp || 0) * 1000 });
    console.log(`[wa] reply from ${phone}${optOut ? ' (opt-out → DND)' : ''}`);
  } catch (e) {
    console.error('[wa] reading a message failed', e.message);
  }
});

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Digits with the country code: a 10-digit Indian number gets 91 in front, a leading 0 is dropped. */
const toDigits = (phone) => {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = COUNTRY + d;
  return d.length >= 11 && d.length <= 15 ? d : '';
};
const isDnd = (phone) => dnd.has(toDigits(phone));

/** The chat id for a number, or an error worth showing when it is not on WhatsApp. */
const chatIdFor = async (phone) => {
  const d = toDigits(phone);
  if (!d) throw new Error('Not a valid phone number');
  const id = await client.getNumberId(d).catch(() => null);
  if (!id) throw new Error('This number is not on WhatsApp');
  return id._serialized || `${d}@c.us`;
};

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

const fill = (template, c) => String(template || '')
  .replace(/\{fullname\}/gi, String(c.name || '').trim() || 'there')
  .replace(/\{name\}/gi, firstName(c.name))
  .replace(/\{phone\}/gi, String(c.phone || ''))
  .replace(/\{segment\}/gi, process.env.OFFER_NAME || 'internship');   // what we offer, never a list's name

/* A little variety, so a campaign is not hundreds of byte-identical messages. */
const GREETINGS = ['Hi', 'Hello', 'Hey'];
const spinText = (text) => text.replace(/^(hi|hello|hey)\b/i, () => GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelayMs = (min, max) => Math.round((min + Math.random() * (max - min)) * 1000);

/** A file the app sent along: { b64, mime, name, voice } → MessageMedia. */
const toMedia = (m) => (m && m.b64 && m.mime ? new MessageMedia(String(m.mime), String(m.b64), m.name ? String(m.name) : undefined) : null);

const send = async (phone, text, mediaUrl, file) => {
  if (!wa.connected) throw new Error('WhatsApp is not connected');
  const chatId = await chatIdFor(phone);
  const media = toMedia(file);
  if (media) {
    const voice = !!file.voice && /^audio\//.test(media.mimetype);
    if (voice) {
      // A voice note carries no caption: the text goes first, then the recording.
      if (text) await client.sendMessage(chatId, text);
      await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
    } else {
      await client.sendMessage(chatId, media, { caption: text || undefined, sendMediaAsDocument: /pdf|msword|officedocument/.test(media.mimetype) });
    }
    return;
  }
  if (mediaUrl) {
    const media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true }).catch(() => null);
    if (media) {
      await client.sendMessage(chatId, media, { caption: text });
      return;
    }
    // A link that is not a file (a web page): send it in the text instead.
    text = text.includes(mediaUrl) ? text : `${text}\n${mediaUrl}`;
  }
  await client.sendMessage(chatId, text);
};

/* ── bulk campaign ────────────────────────────────────────────────────────── */

const campaign = {
  id: 0, running: false, paused: false, cancelled: false,
  total: 0, sent: 0, failed: 0, skippedDnd: 0, currentPhone: null,
  startedAt: 0, finishedAt: 0, nextAt: 0, cooling: false,
  minDelaySec: 12, maxDelaySec: 25, batchSize: 20, cooldownSec: 180,
  results: [],   // { id, phone, name, ok, error, at, text } — the app logs these to the panel
};

const campaignOut = (since) => {
  const { results, ...rest } = campaign;
  const from = Math.max(0, Math.min(results.length, Number(since) || 0));
  return { ...rest, done: results.length, results: results.slice(from), resultsFrom: from };
};

/** Waits `ms`, longer while paused; false as soon as the campaign is cancelled. */
const wait = async (ms) => {
  campaign.nextAt = Date.now() + ms;
  while (Date.now() < campaign.nextAt || campaign.paused) {
    if (campaign.cancelled) return false;
    if (campaign.paused) campaign.nextAt = Math.max(campaign.nextAt, Date.now() + 1000);
    await sleep(400);
  }
  campaign.nextAt = 0;
  return !campaign.cancelled;
};

const runCampaign = async (contacts, template, spin, file) => {
  let sinceCooldown = 0;
  for (let i = 0; i < contacts.length; i++) {
    if (!(await wait(0))) break;
    const c = contacts[i];
    campaign.currentPhone = c.phone;
    let text = fill(template, c);
    if (spin) text = spinText(text);
    const r = { id: c.id ?? null, phone: c.phone, name: c.name || '', ok: false, error: '', at: 0, text };
    if (isDnd(c.phone)) {
      // Opted out since the campaign was picked: never message them.
      r.error = 'DND — opted out';
      campaign.failed++;
      campaign.skippedDnd++;
    } else {
      try {
        await send(c.phone, text, '', file);
        r.ok = true;
        campaign.sent++;
        sinceCooldown++;
      } catch (e) {
        r.error = e.message || String(e);
        campaign.failed++;
        // Lost the session: hold the run until it is back rather than fail everyone left.
        if (!wa.connected) campaign.paused = true;
      }
    }
    r.at = Date.now();
    campaign.results.push(r);
    if (campaign.results.length > RESULTS_KEPT) campaign.results.splice(0, campaign.results.length - RESULTS_KEPT);
    console.log(`[campaign ${campaign.id}] ${i + 1}/${contacts.length} ${c.phone} ${r.ok ? 'sent' : `failed: ${r.error}`}`);
    if (i === contacts.length - 1) break;
    // A longer rest every batch, then the usual random gap.
    let gap = randomDelayMs(campaign.minDelaySec, campaign.maxDelaySec);
    if (campaign.batchSize > 0 && sinceCooldown >= campaign.batchSize) {
      gap += randomDelayMs(campaign.cooldownSec, campaign.cooldownSec * 1.5);
      sinceCooldown = 0;
      campaign.cooling = true;
    }
    const go = await wait(gap);
    campaign.cooling = false;
    if (!go) break;
  }
  campaign.running = false;
  campaign.paused = false;
  campaign.cooling = false;
  campaign.currentPhone = null;
  campaign.nextAt = 0;
  campaign.finishedAt = Date.now();
};

/* ── scheduled messages ───────────────────────────────────────────────────── */

let ticking = false;
setInterval(async () => {
  if (ticking || !wa.connected) return;
  const due = scheduled.filter((s) => s.at <= Date.now());
  if (!due.length) return;
  ticking = true;
  try {
    for (const s of due) {
      scheduled = scheduled.filter((x) => x.key !== s.key);
      saveScheduled();
      const text = fill(s.message, s);
      try {
        if (isDnd(s.phone)) throw new Error('DND — opted out');
        await send(s.phone, text, '', s.media);
        pushEvent({ type: 'sched', key: s.key, group: s.group || '', step: s.step || 0, phone: s.phone, text, ok: true });
      } catch (e) {
        pushEvent({ type: 'sched', key: s.key, phone: s.phone, text, ok: false, error: e.message || String(e) });
      }
      await sleep(randomDelayMs(3, 8));
    }
  } finally {
    ticking = false;
  }
}, 15 * 1000);

/* ── HTTP ─────────────────────────────────────────────────────────────────── */

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' }));   // room for a brochure or a voice note

app.get('/', (_req, res) => res.type('text').send(`Caller IQ WhatsApp bridge — ${wa.connected ? `connected as ${wa.me}` : wa.phase}`));

const api = express.Router();
api.use((req, res, next) => {
  if (!BRIDGE_KEY) return next();
  const key = req.get('X-Bridge-Key') || req.query.key || '';
  if (key !== BRIDGE_KEY) return res.status(401).json({ ok: false, error: 'Wrong or missing bridge key' });
  return next();
});

api.get('/status', (req, res) => {
  const ev = Number(req.query.ev) || 0;
  res.json({
    connected: wa.connected,
    phase: wa.phase,
    me: wa.me,
    error: wa.error,
    qrDataUrl: wa.qrDataUrl,
    campaign: campaignOut(req.query.since),
    events: store.events.filter((e) => e.seq > ev).slice(0, 200),
    evSeq: store.seq,
    scheduled: scheduled.length,
    // Numbers with a drip still running, and what each has left.
    drips: Object.values(scheduled.filter((x) => x.group && x.group.startsWith('drip:')).reduce((a, x) => {
      const k = x.group.slice(5);
      a[k] = a[k] || { phone: k, left: 0, nextAt: x.at };
      a[k].left++;
      a[k].nextAt = Math.min(a[k].nextAt, x.at);
      return a;
    }, {})),
    dnd: dnd.size,
  });
});

/* The QR as a page, for scanning from the computer itself. */
api.get('/qr', (_req, res) => {
  if (wa.connected) return res.type('html').send(`<p>Connected as ${wa.me}.</p>`);
  if (!wa.qrDataUrl) return res.type('html').send('<meta http-equiv="refresh" content="3"><p>Starting… this page refreshes itself.</p>');
  return res.type('html').send(`<meta http-equiv="refresh" content="20"><img src="${wa.qrDataUrl}" alt="WhatsApp QR">`);
});

api.post('/send-single', async (req, res) => {
  const { phone, name, segment, message, mediaUrl, media } = req.body || {};
  if ((!message || !String(message).trim()) && !(media && media.b64)) return res.status(400).json({ ok: false, error: 'The message is empty' });
  if (!wa.connected) return res.status(409).json({ ok: false, error: 'WhatsApp is not connected — scan the QR first' });
  const text = fill(message, { name, phone, segment }).trim();
  try {
    await send(phone, text, mediaUrl ? String(mediaUrl) : '', media);
    return res.json({ ok: true, phone, text, at: Date.now(), dnd: isDnd(phone) });
  } catch (e) {
    return res.status(422).json({ ok: false, error: e.message || String(e) });
  }
});

api.post('/send-bulk', (req, res) => {
  const { contacts, template } = req.body || {};
  if (campaign.running) return res.status(409).json({ ok: false, error: 'A campaign is already running — pause or cancel it first' });
  if (!wa.connected) return res.status(409).json({ ok: false, error: 'WhatsApp is not connected — scan the QR first' });
  if (!template || !String(template).trim()) return res.status(400).json({ ok: false, error: 'The message template is empty' });
  if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ ok: false, error: 'No contacts to send to' });
  if (contacts.length > MAX_CONTACTS) return res.status(400).json({ ok: false, error: `At most ${MAX_CONTACTS} contacts per campaign` });

  // One message per number, even when a person is on the list twice; never to a DND number.
  const seen = new Set();
  let blocked = 0;
  const list = contacts.filter((c) => {
    const d = toDigits(c && c.phone);
    if (!d || seen.has(d)) return false;
    seen.add(d);
    if (dnd.has(d)) { blocked++; return false; }
    return true;
  });
  if (!list.length) return res.status(400).json({ ok: false, error: blocked ? 'Everyone picked has opted out (DND)' : 'None of the contacts has a valid phone number' });

  const min = Math.max(5, Number(req.body.minDelaySec) || 12);
  const max = Math.max(min, Number(req.body.maxDelaySec) || 25);
  const batchSize = Math.max(0, Math.min(500, Number(req.body.batchSize ?? 20) || 0));
  const cooldownSec = Math.max(30, Math.min(3600, Number(req.body.cooldownSec) || 180));
  Object.assign(campaign, {
    id: campaign.id + 1, running: true, paused: false, cancelled: false,
    total: list.length, sent: 0, failed: 0, skippedDnd: 0, currentPhone: null,
    startedAt: Date.now(), finishedAt: 0, nextAt: 0, cooling: false,
    minDelaySec: min, maxDelaySec: max, batchSize, cooldownSec, results: [],
  });
  runCampaign(list, String(template), req.body.spin !== false, req.body.media || null).catch((e) => {
    console.error('[campaign] crashed', e);
    campaign.running = false;
  });
  return res.json({ ok: true, campaign: campaignOut(0), skipped: contacts.length - list.length - blocked, blocked });
});

api.post('/campaign-control', (req, res) => {
  const action = String((req.body || {}).action || '');
  if (!campaign.running) return res.status(409).json({ ok: false, error: 'No campaign is running' });
  if (action === 'pause') campaign.paused = true;
  else if (action === 'resume') {
    if (!wa.connected) return res.status(409).json({ ok: false, error: 'WhatsApp is not connected' });
    campaign.paused = false;
  } else if (action === 'cancel') campaign.cancelled = true;
  else return res.status(400).json({ ok: false, error: 'Use pause, resume or cancel' });
  return res.json({ ok: true, campaign: campaignOut(campaign.results.length) });
});

api.post('/schedule', (req, res) => {
  const { key, phone, name, segment, message, at, group, media } = req.body || {};
  if (!key || !toDigits(phone) || !message || !Number(at)) return res.status(400).json({ ok: false, error: 'Need key, phone, message and at' });
  scheduled = scheduled.filter((s) => s.key !== key);
  scheduled.push({ key: String(key), phone: String(phone), name: name || '', segment: segment || '', message: String(message), at: Number(at), group: group ? String(group) : '', media: media || null });
  saveScheduled();
  return res.json({ ok: true, scheduled: scheduled.length });
});

api.post('/schedule-cancel', (req, res) => {
  const { key, group, phone } = req.body || {};
  if (group || phone) return res.json({ ok: true, removed: cancelGroup(group ? String(group) : dripGroup(phone)) });
  const before = scheduled.length;
  scheduled = scheduled.filter((s) => s.key !== String(key || ''));
  saveScheduled();
  return res.json({ ok: true, removed: before - scheduled.length });
});

api.get('/schedule', (req, res) => {
  const d = toDigits(req.query.phone);
  res.json({ items: scheduled.filter((x) => !d || toDigits(x.phone) === d).map(({ media, ...x }) => ({ ...x, hasMedia: !!media })).sort((a, b) => a.at - b.at) });
});

/* A drip: the same steps for every contact, each step `afterMin` minutes after enrolling. The
   first steps of a big enrolment are spread out (gapSec apart) so they do not all go at once. */
api.post('/drip', (req, res) => {
  const { key, contacts, steps } = req.body || {};
  const gap = Math.max(5, Number(req.body.gapSec) || 15);
  if (!key || !Array.isArray(contacts) || !contacts.length || !Array.isArray(steps) || !steps.length) return res.status(400).json({ ok: false, error: 'Need key, contacts and steps' });
  const now = Date.now();
  let enrolled = 0; let blocked = 0;
  contacts.forEach((c, i) => {
    const d = toDigits(c && c.phone);
    if (!d) return;
    if (dnd.has(d)) { blocked++; return; }
    cancelGroup(`drip:${d}`);   // enrolling again starts over
    steps.forEach((st, j) => {
      if (!st || !String(st.message || '').trim()) return;
      scheduled.push({
        key: `${key}:${d}:${j + 1}`, group: `drip:${d}`, step: j + 1, phone: c.phone, name: c.name || '', segment: c.segment || '',
        message: String(st.message), at: now + Math.max(0, Number(st.afterMin) || 0) * 60000 + i * gap * 1000, media: null,
      });
    });
    enrolled++;
  });
  saveScheduled();
  return res.json({ ok: true, enrolled, blocked });
});

/* ── PC → phone dialing ── */
api.post('/dial', (req, res) => {
  const { phone, name, segment } = req.body || {};
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (d.replace(/\D/g, '').length < 6) return res.status(400).json({ ok: false, error: 'Not a valid phone number' });
  const item = { phone: d, name: String(name || '').slice(0, 80), segment: String(segment || '').slice(0, 80), at: Date.now() };
  dials.unshift(item);
  dials.splice(20);
  pushEvent({ type: 'dial', phone: d, text: item.name, name: item.name, segment: item.segment });
  return res.json({ ok: true });
});
api.get('/dials', (_req, res) => res.json({ items: dials }));

api.get('/dnd', (_req, res) => res.json({ numbers: [...dnd] }));
api.post('/dnd', (req, res) => {
  const d = toDigits((req.body || {}).phone);
  if (!d) return res.status(400).json({ ok: false, error: 'Not a valid phone number' });
  if (req.body.dnd === false) dnd.delete(d); else dnd.add(d);
  saveDnd();
  return res.json({ ok: true, dnd: dnd.has(d) });
});

api.post('/logout', async (_req, res) => {
  try {
    await client.logout();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.use('/api/whatsapp', api);

/* ── the two dialer pages (plain HTML, no build step) ── */
const lanIp = () => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) return a.address;
  }
  return 'localhost';
};
const keyOk = (req, res) => {
  if (!BRIDGE_KEY || req.query.key === BRIDGE_KEY) return true;
  res.status(401).type('html').send('<p>Open this page with ?key=YOUR_BRIDGE_KEY</p>');
  return false;
};
const esc = (v) => String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE_CSS = `
  :root{--bg:#F8FAFC;--card:#fff;--text:#0F172A;--muted:#64748B;--line:#E2E8F0;--pri:#2563EB;--ok:#16A34A}
  @media (prefers-color-scheme:dark){:root{--bg:#0B1220;--card:#111A2E;--text:#E2E8F0;--muted:#94A3B8;--line:#1E293B;--pri:#60A5FA;--ok:#4ADE80}}
  *{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--text)}
  main{max-width:720px;margin:0 auto;padding:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
  input,textarea{width:100%;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text)}
  button,a.btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-weight:700;padding:10px 14px;border-radius:999px;border:0;background:var(--pri);color:#fff;text-decoration:none;cursor:pointer}
  a.btn.ok{background:var(--ok)}.muted{color:var(--muted);font-size:13px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  li{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}ul{list-style:none;padding:0;margin:0}
`;
app.get('/dialer', async (req, res) => {
  if (!keyOk(req, res)) return;
  const mobileUrl = `http://${lanIp()}:${PORT}/m${BRIDGE_KEY ? `?key=${encodeURIComponent(BRIDGE_KEY)}` : ''}`;
  const qr = await QRCode.toDataURL(mobileUrl, { margin: 1, width: 220 }).catch(() => '');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Caller IQ dialer</title><style>${PAGE_CSS}</style></head><body><main>
  <h1>Call from the laptop</h1>
  <p class="muted">Paste or type numbers (one per line, optionally "Name, number"). <b>Call on phone</b> pops the number up in the Caller IQ app (and the mobile dialer view below); <b>tel:</b> hands it to Windows Phone Link / Mac Continuity.</p>
  <div class="card"><textarea id="nums" rows="4" placeholder="Priya, 98765 43210"></textarea>
  <div class="row" style="margin-top:10px"><button onclick="add()">Add to the list</button><span class="muted" id="msg"></span></div></div>
  <div class="card"><ul id="list"></ul></div>
  <div class="card row"><img src="${qr}" width="160" height="160" alt="QR for the mobile dialer view" style="background:#fff;border-radius:8px">
  <div><b>Mobile dialer view</b><p class="muted">Scan with the phone you call from (same Wi-Fi). It shows each number you push here with one big Call button — no app needed.</p><code class="muted">${esc(mobileUrl)}</code></div></div>
  <script>
  const KEY=${JSON.stringify(BRIDGE_KEY)};const H={'Content-Type':'application/json','X-Bridge-Key':KEY};
  let items=JSON.parse(localStorage.getItem('ciq_dial')||'[]');
  const save=()=>{try{localStorage.setItem('ciq_dial',JSON.stringify(items))}catch(e){}};
  function add(){document.getElementById('nums').value.split(/\\n+/).map(l=>l.trim()).filter(Boolean).forEach(l=>{const m=l.match(/^(.*?)[,;\\t]\\s*([+\\d][\\d\\s-]{5,})$/);items.push(m?{name:m[1].trim(),phone:m[2].replace(/[\\s-]/g,'')}:{name:'',phone:l.replace(/[\\s-]/g,'')})});document.getElementById('nums').value='';save();draw()}
  async function push(i){const it=items[i];const r=await fetch('/api/whatsapp/dial',{method:'POST',headers:H,body:JSON.stringify(it)});document.getElementById('msg').textContent=r.ok?'Sent to the phone: '+(it.name||it.phone):'Could not reach the bridge';it.done=1;save();draw()}
  function del(i){items.splice(i,1);save();draw()}
  function draw(){document.getElementById('list').innerHTML=items.map((it,i)=>'<li><span>#'+(i+1)+' <b>'+(it.name||'')+'</b> '+it.phone+(it.done?' ✓':'')+'</span><span class="row"><button onclick="push('+i+')">Call on phone</button><a class="btn ok" href="tel:'+it.phone+'">tel:</a><button style="background:transparent;color:inherit" onclick="del('+i+')">✕</button></span></li>').join('')||'<li class="muted">No numbers yet.</li>'}
  draw();
  </script></main></body></html>`);
});
app.get('/m', (req, res) => {
  if (!keyOk(req, res)) return;
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dial</title><style>${PAGE_CSS}
  .big{font-size:30px;font-weight:800;letter-spacing:.5px}.call{font-size:22px;padding:18px 28px;width:100%;justify-content:center}</style></head><body><main>
  <p class="muted">Caller IQ · mobile dialer — numbers pushed from the laptop appear here.</p>
  <div class="card" id="now"><p class="muted">Waiting for a number…</p></div>
  <div class="card"><b>Earlier</b><ul id="old"></ul></div>
  <script>
  const KEY=${JSON.stringify(BRIDGE_KEY)};let last=0;
  async function tick(){try{const r=await fetch('/api/whatsapp/dials?key='+encodeURIComponent(KEY));const d=await r.json();const it=d.items||[];
  if(it[0]){const a=it[0];document.getElementById('now').innerHTML='<div class="muted">'+(a.segment||'')+'</div><div class="big">'+(a.name||'')+'</div><div class="big">'+a.phone+'</div><p><a class="btn ok call" href="tel:'+a.phone+'">📞 Call</a></p>';
  if(a.at>last&&last){try{navigator.vibrate&&navigator.vibrate([200,100,200])}catch(e){}}last=a.at}
  document.getElementById('old').innerHTML=it.slice(1).map(x=>'<li><span>'+(x.name||'')+' '+x.phone+'</span><a class="btn ok" href="tel:'+x.phone+'">Call</a></li>').join('')}catch(e){}}
  tick();setInterval(tick,3000);
  </script></main></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[bridge] Listening on port ${PORT}${BRIDGE_KEY ? ' (bridge key required)' : ' — WARNING: no BRIDGE_KEY set, anyone on this network can send messages'}`);
  console.log(`[bridge] Laptop dialer: http://${lanIp()}:${PORT}/dialer${BRIDGE_KEY ? '?key=…' : ''}`);
});
client.initialize().catch((e) => {
  wa.phase = 'error';
  wa.error = e.message || String(e);
  console.error('[wa] could not start WhatsApp Web:', e);
});
