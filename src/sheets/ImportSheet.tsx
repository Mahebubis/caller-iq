import React, { useEffect, useMemo, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { chunkRow, fetchCsv, Field4, loadLinks, parseLeadTime, parseTable, saveLinks, sheetCsvUrl, SheetLink } from '../sheetSync';
import { makeStyles, radius, space, useTheme } from '../theme';
import { num, plural } from '../format';
import { panelAsk } from '../api';
import { Agent, crm, hourWindow, native, scrubPhone } from '../crm';
import { Banner, Button, Chip, ChipBar, Field, Icon, ProgressBar, Segmented, Select, Sheet } from '../ui';

/*
 * Import a calling list from a CSV on this phone, straight into the panel (imports.php start →
 * chunk → finish, the same path as the admin panel's importer):
 *   - columns are matched by their headers and can be changed (phone, name, email, status, time)
 *   - every row gets the status picked here unless its own status column says otherwise — never
 *     "Called" unless that is what was picked
 *   - the number scrubber cleans each phone (spaces, dashes, +91, a leading 0) and counts the ones
 *     that still are not a valid mobile: they import as "Needs review"
 *   - duplicates are checked against every list before anything is saved, and handled the way
 *     picked: skip them, overwrite their status elsewhere, or merge history (+1 missed call)
 *   - a time column gives each lead its "best time to call" (the hour they called us)
 *   - or a Google Sheet link instead of a file: the list then keeps pulling new rows from it
 *   - the people can be shared out between agents straight away (round robin)
 */

const DEFAULT_STATUSES = [
  { key: 'needs_callback', label: 'Needs callback' }, { key: 'missed_call', label: 'Missed call' },
  { key: 'not_called', label: 'Not called' }, { key: 'pending_followup', label: 'Pending follow-up' }, { key: 'called', label: 'Called' },
];
const DUPE_MODES = [
  { key: 'skip', label: 'Skip duplicates', desc: 'People already on a list are left out.' },
  { key: 'overwrite', label: 'Overwrite status', desc: 'They are added, and their status on older lists becomes this one.' },
  { key: 'merge', label: 'Merge history', desc: 'They are added with their notes, and their inbound missed count goes up by one.' },
  { key: 'keep', label: 'Keep both', desc: 'Added as they are; duplicates are only counted.' },
];
const GUESS: { [k in Field4]: RegExp } = {
  phone: /phone|mobile|contact\s*no|number|whatsapp|cell/i,
  name: /^(full\s*)?name$|student|customer|lead\s*name|^name/i,
  email: /mail/i,
  status: /status|disposition|stage/i,
  time: /time|date|created|timestamp|called\s*at|received/i,
};
const CHUNK = 1000;

export default function ImportSheet({ visible, syncEndpoint, onClose, onImported }: {
  visible: boolean;
  syncEndpoint: string;
  onClose: () => void;
  onImported: (id: number, name: string) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [file, setFile] = useState<{ name: string; headers: string[]; rows: string[][] } | null>(null);
  const [map, setMap] = useState<{ [k in Field4]: number }>({ phone: -1, name: -1, email: -1, status: -1, time: -1 });
  const [listName, setListName] = useState<string>('');
  const [defStatus, setDefStatus] = useState<string>('not_called');
  const [dupeMode, setDupeMode] = useState<string>('skip');
  const [dupes, setDupes] = useState<{ duplicates: number; in_file: number; lists: { name: string; numbers: number }[] } | null>(null);
  const [checking, setChecking] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(-1);
  const [error, setError] = useState<string>('');
  const [source, setSource] = useState<'file' | 'sheet'>('file');
  const [sheetUrl, setSheetUrl] = useState<string>('');
  const [keepSync, setKeepSync] = useState<boolean>(true);
  const [fetching, setFetching] = useState<boolean>(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [split, setSplit] = useState<string[]>([]);

  useEffect(() => {
    if (visible && !agents.length) crm.agents().then(setAgents).catch(() => {});
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = (body: any, ms = 60000) => panelAsk('imports.php', body, syncEndpoint, ms);

  const reset = () => { setFile(null); setDupes(null); setProgress(-1); setError(''); setSplit([]); };
  const close = () => { if (progress >= 0 && progress < 1) return; reset(); onClose(); };

  const pick = async () => {
    setError('');
    try {
      const f = await native.pickTextFile();
      if (!f) return;
      if (/\.xlsx?$/i.test(f.name)) { setError('Excel files: save the sheet as CSV first (File → Save as → CSV), then pick that.'); return; }
      setSheetUrl('');
      take(f.name, f.text);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const fetchSheet = async () => {
    if (!sheetUrl.trim()) return;
    setError('');
    setFetching(true);
    try {
      take('Google Sheet', await fetchCsv(sheetUrl));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setFetching(false);
    }
  };

  /** A CSV's text, from a file or a sheet: columns guessed from the headers. */
  const take = (name: string, text: string) => {
    try {
      const { headers, rows } = parseTable(text);
      if (!rows.length) { setError('That file has no rows under its header.'); return; }
      const guess = (k: Field4, avoid: number[] = []) => headers.findIndex((h, i) => !avoid.includes(i) && GUESS[k].test(h));
      const phone = guess('phone');
      const m = { phone, name: guess('name', [phone]), email: guess('email', [phone]), status: guess('status', [phone]), time: guess('time', [phone]) };
      // No phone header: the column whose cells look most like numbers.
      if (m.phone < 0) {
        let best = -1; let score = 0;
        headers.forEach((_, i) => {
          const n = rows.slice(0, 50).filter((r) => scrubPhone(r[i]).ok).length;
          if (n > score) { score = n; best = i; }
        });
        m.phone = best;
      }
      setMap(m);
      setFile({ name, headers, rows });
      setListName(name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 150));
      setDupes(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  /* The scrubber's verdict and the golden hours, over the whole file. */
  const report = useMemo(() => {
    if (!file || map.phone < 0) return null;
    let ok = 0; const bad: string[] = []; const seen = new Set<string>(); let inFile = 0;
    const hours = new Array(24).fill(0);
    file.rows.forEach((r) => {
      const p = scrubPhone(r[map.phone]);
      if (p.ok) {
        ok++;
        if (seen.has(p.digits)) inFile++; else seen.add(p.digits);
      } else if (r[map.phone]) bad.push(r[map.phone]);
      if (map.time >= 0) {
        const lt = parseLeadTime(r[map.time]);
        if (lt.h != null) hours[lt.h]++;
      }
    });
    const top = hours.map((n, h) => ({ h, n })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
    return { ok, bad, empty: file.rows.length - ok - bad.length, inFile, phones: [...seen], top };
  }, [file, map.phone, map.time]);

  const checkDupes = async () => {
    if (!report) return;
    setChecking(true);
    try {
      setDupes(await ask({ action: 'dupes', phones: report.phones }));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setChecking(false);
    }
  };

  const run = async () => {
    if (!file || !report || map.phone < 0) return;
    setError('');
    setProgress(0);
    try {
      const mapping: any = { phone: file.headers[map.phone] };
      if (map.name >= 0) mapping.name = [file.headers[map.name]];
      if (map.email >= 0) mapping.email = file.headers[map.email];
      if (map.status >= 0) mapping.status = file.headers[map.status];
      if (map.time >= 0) mapping.time = file.headers[map.time];
      const st = await ask({ action: 'start', name: listName.trim() || file.name, file_name: file.name, headers: file.headers, mapping, total: file.rows.length, default_status: defStatus, dupe_mode: dupeMode });
      const id = Number(st.id);
      for (let i = 0; i < file.rows.length; i += CHUNK) {
        const rows = file.rows.slice(i, i + CHUNK).map((r, j) => chunkRow(r, map, i + j + 1));
        await ask({ action: 'chunk', id, rows }, 120000);
        setProgress(Math.min(0.97, (i + CHUNK) / file.rows.length));
      }
      await ask({ action: 'finish', id }, 120000);
      // Shared out between agents, 1st to the first, 2nd to the second…
      if (split.length) await crm.assign(id, split, { all: true }).catch((e: any) => setError(`Imported, but not shared out — ${e?.message || e}`));
      // Linked to the sheet: new rows keep arriving (ImportsScreen syncs every 2 minutes).
      if (sheetUrl && keepSync) {
        const name = (k: Field4) => (map[k] >= 0 ? file.headers[map[k]] : undefined);
        const link: SheetLink = {
          listId: id, listName: listName.trim() || file.name, url: sheetCsvUrl(sheetUrl),
          map: { phone: name('phone'), name: name('name'), email: name('email'), status: name('status'), time: name('time') },
          defStatus, seen: report.phones.concat(report.bad), lastAt: Date.now(), lastAdded: 0, error: '',
        };
        saveLinks([...(await loadLinks()).filter((l) => l.listId !== id), link]);
      }
      setProgress(1);
      onImported(id, listName.trim() || file.name);
      reset();
      onClose();
    } catch (e: any) {
      setProgress(-1);
      setError(`Import stopped — ${e?.message || e}`);
    }
  };

  /* "Name → Column A · Full name": one dropdown per field. */
  const letter = (i: number) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));
  const colSelect = (k: Field4, label: string, optional: boolean) => (
    <Select
      label={label}
      value={map[k]}
      options={[...(optional ? [{ key: -1, label: 'Not in this file' }] : []), ...file!.headers.map((h, i) => ({ key: i, label: `Column ${letter(i)} · ${h}` }))]}
      onChange={(i: number) => { setMap({ ...map, [k]: i }); if (k === 'phone') setDupes(null); }}
    />
  );

  const importing = progress >= 0;
  return (
    <Sheet
      visible={visible}
      onClose={close}
      title="Import a calling list"
      subtitle={file ? `${file.name} · ${plural(file.rows.length, 'row')}` : 'A CSV from this phone — the admin panel sees it at once'}
      footer={file ? (
        <View style={s.footer}>
          <Button label="Other file" variant="secondary" onPress={pick} disabled={importing} style={{ flex: 1 }} />
          <Button
            label={importing ? `Importing ${Math.round(progress * 100)}%` : `Import ${num(file.rows.length - (dupeMode === 'skip' && dupes ? dupes.duplicates : 0))}`}
            icon="upload_file"
            variant="success"
            onPress={run}
            loading={importing}
            disabled={map.phone < 0 || importing}
            style={{ flex: 1.6 }}
          />
        </View>
      ) : undefined}
    >
      {!!error && <Banner tone="danger" icon="error_outline" message={error} />}
      {!file ? (
        <View>
          <Segmented options={[{ key: 'file', label: 'CSV file' }, { key: 'sheet', label: 'Google Sheet link' }]} value={source} onChange={setSource} />
          {source === 'file' ? (
            <View style={s.dropzone}>
              <View style={s.dropIcon}><Icon name="cloud_upload" size={34} color={t.c.link} /></View>
              <Text style={s.dropTitle}>Upload a contact list</Text>
              <Text style={s.emptyText}>CSV file with the column names in the first row (save Excel sheets as CSV).</Text>
              <Button label="Choose File" icon="upload_file" pill onPress={pick} style={{ minWidth: 170 }} />
            </View>
          ) : (
            <View style={{ paddingTop: space.md }}>
              <Field
                label="Google Sheet link"
                value={sheetUrl}
                onChangeText={setSheetUrl}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                autoCapitalize="none"
                autoCorrect={false}
                hint="Share it as “Anyone with the link can view” (or Publish to web). Any public CSV link works too."
              />
              <Button label="Load the sheet" icon="download" onPress={fetchSheet} loading={fetching} disabled={!sheetUrl.trim()} />
            </View>
          )}
        </View>
      ) : (
        <View>
          {importing && <ProgressBar value={progress} color={t.c.emerald} />}
          <Field label="List name" value={listName} onChangeText={setListName} maxLength={150} />

          <Text style={s.label}>Mapping preview</Text>
          {colSelect('name', 'Name', true)}
          {colSelect('phone', 'Phone Number', false)}
          {colSelect('time', 'Time they called', true)}
          {colSelect('status', 'Status column', true)}
          {colSelect('email', 'Email', true)}
          <Select label="Default Status" value={defStatus} options={DEFAULT_STATUSES} onChange={setDefStatus} />
          {defStatus === 'called' && <Text style={s.warn}>Everyone imported will count as already called.</Text>}

          <Text style={s.dupeDesc}>A filled status column overrides the default; the time column gives each lead their best time to call.</Text>

          {report && (
            <View style={s.report}>
              <ReportLine icon="check_circle" color={t.c.success} text={`${num(report.ok)} valid mobile numbers`} />
              {report.bad.length > 0 && (
                <ReportLine icon="warning_amber" color={t.c.warning} text={`${num(report.bad.length)} need review — e.g. ${report.bad.slice(0, 3).join(', ')}`} />
              )}
              {report.empty > 0 && <ReportLine icon="info_outline" color={t.c.muted} text={`${num(report.empty)} rows without a phone number`} />}
              {report.inFile > 0 && <ReportLine icon="info_outline" color={t.c.muted} text={`${num(report.inFile)} numbers appear twice in this file`} />}
              {report.top.length > 0 && (
                <ReportLine icon="schedule" color={t.c.blue} text={`Most called us ${report.top.map((x) => hourWindow(x.h)).join(', ')}`} />
              )}
            </View>
          )}

          <Text style={s.label}>Duplicates</Text>
          {dupes ? (
            <Text style={s.dupeText}>
              {dupes.duplicates ? `${num(dupes.duplicates)} already on a list${dupes.lists[0] ? ` (most on “${dupes.lists[0].name}”)` : ''}.` : 'None of these numbers is on another list.'}
            </Text>
          ) : (
            <Button label="Check against every list" icon="search" size="sm" variant="secondary" loading={checking} onPress={checkDupes} style={{ alignSelf: 'flex-start', marginBottom: space.sm }} />
          )}
          <ChipBar>
            {DUPE_MODES.map((m) => (
              <Chip key={m.key} label={m.label} selected={dupeMode === m.key} onPress={() => setDupeMode(m.key)} />
            ))}
          </ChipBar>
          <Text style={s.dupeDesc}>{DUPE_MODES.find((m) => m.key === dupeMode)?.desc}</Text>

          {agents.length > 1 && (
            <>
              <Text style={s.label}>Share out between (round robin)</Text>
              <ChipBar>
                {agents.map((a) => (
                  <Chip key={a.device_id} label={a.name} selected={split.includes(a.device_id)}
                    onPress={() => setSplit(split.includes(a.device_id) ? split.filter((x) => x !== a.device_id) : [...split, a.device_id])} />
                ))}
              </ChipBar>
              <Text style={s.dupeDesc}>
                {split.length ? `About ${num(Math.ceil(file.rows.length / split.length))} people each, in turn.` : 'Nobody picked: everyone on the team can call anyone.'}
              </Text>
            </>
          )}

          {!!sheetUrl && (
            <View style={s.syncRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.syncTitle}>Keep pulling new rows</Text>
                <Text style={s.dupeDesc}>Every 2 minutes while the app is open, new numbers in the sheet join this list.</Text>
              </View>
              <Switch value={keepSync} onValueChange={setKeepSync} trackColor={{ false: t.c.borderStrong, true: t.c.primaryLine }} thumbColor={keepSync ? t.c.primary : t.c.surface} />
            </View>
          )}
        </View>
      )}
    </Sheet>
  );
}

const ReportLine = ({ icon, color, text }: { icon: any; color: string; text: string }) => {
  const s = useStyles();
  return (
    <View style={s.reportLine}>
      <Icon name={icon} size={16} color={color} />
      <Text style={s.reportText}>{text}</Text>
    </View>
  );
};

const useStyles = makeStyles((t) => ({
  footer: { flexDirection: 'row', gap: 10, marginTop: space.lg },
  empty: { alignItems: 'center', gap: 14, paddingVertical: space.xl },
  dropzone: {
    alignItems: 'center', gap: 12, paddingVertical: space.xxl, paddingHorizontal: space.lg, marginTop: space.md,
    borderWidth: 2, borderStyle: 'dashed', borderColor: '#F48FB1', borderRadius: 22, backgroundColor: t.c.surfaceAlt,
  },
  dropIcon: { width: 68, height: 68, borderRadius: 22, backgroundColor: t.c.surface, alignItems: 'center', justifyContent: 'center' },
  dropTitle: { fontSize: 16, fontWeight: '800', color: t.c.text },
  emptyText: { fontSize: 13.5, color: t.c.textSoft, textAlign: 'center', lineHeight: 20 },
  label: { fontSize: 12, fontWeight: '700', color: t.c.muted, marginTop: space.md, marginBottom: 6 },
  warn: { fontSize: 12, color: t.c.warning, fontWeight: '600', marginTop: 4 },
  report: { backgroundColor: t.c.surfaceAlt, borderRadius: radius.md, padding: 12, gap: 7, marginTop: space.md },
  reportLine: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  reportText: { flex: 1, fontSize: 12.5, color: t.c.textSoft, lineHeight: 18 },
  dupeText: { fontSize: 13, color: t.c.text, marginBottom: space.sm },
  dupeDesc: { fontSize: 12, color: t.c.muted, marginTop: 6 },
  syncRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: space.lg },
  syncTitle: { fontSize: 14, fontWeight: '600', color: t.c.text },
}));
