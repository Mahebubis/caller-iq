import { NativeModules } from 'react-native';
import { crm } from './crm';
import { OFFER } from './sales';

const { CallBridge } = NativeModules;

/*
 * Saved WhatsApp templates, shared by the team (crm.php settings "wa_templates"; kept on the phone
 * too, so they work offline and with an older panel). A template is written once and filled in
 * for every person it goes to:
 *
 *   {name} or [Name]        their first name   — "Samiye Patel" → "Samiye" ("there" if no name)
 *   {fullname} or [Full Name]  the whole name as saved
 *   {segment} or [Segment]  "internship" — what we offer (never the calling list's name)
 *   {phone} or [Phone]      their number
 *   {me} or [Me]            the counselor sending it
 *
 * Square brackets are turned into braces before sending, so both spellings work everywhere.
 */

export interface WaTemplate { id: string; title: string; text: string; isDefault?: boolean }

const CACHE = 'wa_templates_v2';

export const PLACEHOLDERS: { token: string; label: string }[] = [
  { token: '{name}', label: 'First name' },
  { token: '{fullname}', label: 'Full name' },
  { token: '{segment}', label: 'Internship' },
  { token: '{phone}', label: 'Phone' },
  { token: '{me}', label: 'My name' },
];

export const DEFAULT_TEMPLATES: WaTemplate[] = [
  { id: 'missed', title: 'Missed your call', isDefault: true, text: 'Hi {name}, this is {me} from Internship Studio. I tried calling you about {segment} — when is a good time to talk?' },
  { id: 'followup', title: 'Follow-up', text: 'Hi {name}, just following up on {segment}. Do you have any questions I can answer? Reply here and I’ll call you back.' },
  { id: 'details', title: 'Course details', text: 'Hi {name}, here are the details of {segment} you asked about. Live mentor sessions, real projects and a certificate. Shall I reserve a seat for you?' },
  { id: 'offer', title: 'Offer reminder', text: 'Hi {name}, a quick reminder — the special price for {segment} ends today. Reply YES and I’ll hold your seat. — {me}' },
  { id: 'thanks', title: 'Thank you', text: 'Hi {name}, thank you for joining {segment}! 🎉 If a friend would like the same, just share their number with me.' },
  { id: 'hinglish', title: 'Hinglish — missed call', text: 'Hi {name}, main {me} Internship Studio se. Maine aapko {segment} ke liye call kiya tha — baat karne ka sahi time kab hai?' },
];

/** "[Name]", "[Full Name]", "[segment]"… → "{name}", "{fullname}", "{segment}". */
export const normalizeTemplate = (text: string) => String(text || '')
  .replace(/\[\s*full\s*name\s*\]/gi, '{fullname}')
  .replace(/\[\s*(name|first\s*name)\s*\]/gi, '{name}')
  .replace(/\[\s*(segment|list)\s*\]/gi, '{segment}')
  .replace(/\[\s*(phone|number|mobile)\s*\]/gi, '{phone}')
  .replace(/\[\s*(me|my\s*name)\s*\]/gi, '{me}')
  .replace(/\{\s*(full\s*name)\s*\}/gi, '{fullname}')
  .replace(/\{\s*(first\s*name|Name)\s*\}/g, '{name}');

/** Ready to send: brackets normalised and {me} filled (the same for every person). */
export const prepareTemplate = (text: string, me: string) =>
  normalizeTemplate(text).replace(/\{me\}/gi, (me || '').trim() || 'our team').replace(/\{segment\}/gi, OFFER);

/** What one person receives — for previews and the WhatsApp-on-this-phone fallback. */
export const fillFor = (text: string, c: { name?: string; phone?: string; segment?: string }, me: string) => {
  const full = (c.name || '').trim();
  return prepareTemplate(text, me)
    .replace(/\{fullname\}/gi, full || 'there')
    .replace(/\{name\}/gi, full.split(/\s+/)[0] || 'there')
    .replace(/\{phone\}/gi, c.phone || '')
    .replace(/\{segment\}/gi, OFFER);
};

const clean = (list: any): WaTemplate[] => (Array.isArray(list) ? list : [])
  .filter((x) => x && typeof x.text === 'string' && x.text.trim())
  .map((x, i) => ({ id: String(x.id || `t${i}_${Date.now()}`), title: String(x.title || `Template ${i + 1}`).slice(0, 60), text: String(x.text).slice(0, 1000), isDefault: !!x.isDefault }));

/** The team's templates (or this phone's copy, or the built-in ones). */
export const loadTemplates = async (): Promise<WaTemplate[]> => {
  let local: WaTemplate[] = [];
  try {
    const raw = await CallBridge?.loadUiCache?.(CACHE);
    local = raw ? clean(JSON.parse(raw)) : [];
  } catch (_) {}
  try {
    const team = clean((await crm.settingsGet(['wa_templates' as any]) as any).wa_templates);
    if (team.length) {
      CallBridge?.saveUiCache?.(CACHE, JSON.stringify(team));
      return team;
    }
  } catch (_) {}
  return local.length ? local : DEFAULT_TEMPLATES;
};

/** Saved for the team; still kept on this phone if the panel cannot take it. */
export const saveTemplates = async (list: WaTemplate[]): Promise<'team' | 'phone'> => {
  const next = clean(list);
  CallBridge?.saveUiCache?.(CACHE, JSON.stringify(next));
  try {
    await crm.settingsSet('wa_templates' as any, next);
    return 'team';
  } catch (_) {
    return 'phone';
  }
};

export const defaultOf = (list: WaTemplate[]) => list.find((t) => t.isDefault) || list[0] || DEFAULT_TEMPLATES[0];
