# Caller IQ — WhatsApp bridge

A small Node service that sends the app's WhatsApp messages through **WhatsApp Web** on a
computer you leave running. It powers the app's 1-tap WhatsApp after an unanswered call, the
WhatsApp step in the auto-dialer, and bulk WhatsApp campaigns from a calling list.

## Run it

```bash
cd whatsapp-bridge
npm install            # downloads whatsapp-web.js and a Chrome for it (~150 MB, once)
BRIDGE_KEY=pick-a-long-secret npm start
```

On Windows PowerShell: `$env:BRIDGE_KEY="pick-a-long-secret"; npm start`

Then in the app: **Settings → WhatsApp bridge**. Enter `http://<this computer's IP>:3001` and the
same key, and tap the **WhatsApp** badge in the top bar to scan the QR with the phone that owns the
WhatsApp account (WhatsApp → Linked devices → Link a device). The login is saved in
`.wwebjs_auth/`, so you only scan once. You can also open `http://localhost:3001/api/whatsapp/qr`
on the computer itself.

| Variable       | Default | Meaning                                                    |
|----------------|---------|------------------------------------------------------------|
| `PORT`         | `3001`  | Port to listen on                                          |
| `BRIDGE_KEY`   | (none)  | Required as `X-Bridge-Key` on every request. **Set it.**   |
| `COUNTRY_CODE` | `91`    | Put in front of 10-digit numbers                           |
| `HEADLESS`     | `true`  | `false` shows the Chrome window, which helps with debugging |
| `CHROME_PATH`  | (none)  | Use an installed Chrome or Edge instead of the one npm downloads |

The phone and the computer must be able to reach each other (same Wi-Fi, a VPN, or the bridge on a
server with a public address). The app allows plain `http://`.

## Endpoints

All under `/api/whatsapp`:

- `GET /status?since=N&ev=M`: connection, the QR as a data URL while it waits for a scan, the
  campaign's progress (per-contact results from index `N` on), and events after seq `M`.
- `POST /send-single` `{ phone, name, segment, message, mediaUrl? }`: a direct file link (PDF,
  image) is sent as the file with the message as its caption.
- `POST /send-bulk` `{ contacts: [{ id, name, phone, segment }], template, minDelaySec, maxDelaySec, spin, batchSize, cooldownSec }`:
  a random 12–25 s gap between messages, plus a 3–4.5 min rest after every 20 by default.
- `POST /campaign-control` `{ action: "pause" | "resume" | "cancel" }`
- `POST /schedule` `{ key, phone, name, segment, message, at }` and `POST /schedule-cancel` `{ key }`:
  a message sent later, even with the app closed (used for the offer-hold reminder).
- `GET /dnd`, `POST /dnd` `{ phone, dnd }`: the numbers that are never sent bulk messages.
- `POST /drip` `{ key, contacts, steps: [{ afterMin, message }] }`: a follow-up sequence per number
  (group `drip:<digits>`); a reply from that number cancels what is left. `POST /schedule-cancel`
  `{ phone }` stops one; `GET /schedule?phone=` lists what is still to go.
- `media: { b64, mime, name, voice }` on `send-single`, `send-bulk` and `schedule`: a PDF, image or
  audio file (≤ 16 MB) sent with the message as its caption; `voice: true` sends audio as a voice note.
- `POST /dial` `{ phone, name }`: pushes a number to the phones (event `dial`); `GET /dials` lists them.

### Laptop dialer

`http://<this computer's IP>:3001/dialer?key=<BRIDGE_KEY>` — paste numbers, then **Call on phone**
(the Caller IQ app pops it up with a Call button) or **tel:** (Windows Phone Link / Mac
Continuity). The QR on that page opens `/m`, a mobile dialer view for any phone on the same Wi-Fi:
the latest pushed number with one big Call button.
- `POST /logout`

`{name}` (first name), `{phone}` and `{segment}` are filled in for each contact.

### Replies and opt-outs

Every message a person sends to the linked WhatsApp becomes an event (`type: "in"`). The app
forwards events to the panel (`crm.php wa_inbound`), which marks a lead on a calling list
**Replied - Priority**, awards +30 points to whoever messaged them last, and pushes an alert to
the top of the Live Call Feed. A reply containing STOP, DND, unsubscribe or "not interested"
(also मत भेजो / बंद करो / नहीं चाहिए) makes the number **DND** at once: the bridge never includes it
in a bulk campaign again, and the panel tags it DND for the whole team.

DND numbers, scheduled messages and recent events are kept in `data/`, so a restart keeps them.

## Read this before running campaigns

whatsapp-web.js is **not** an official WhatsApp API. Automated or bulk messaging from a normal
WhatsApp account breaks WhatsApp's Terms of Service, and WhatsApp can ban the number with no
warning and no appeal. The random delay and greeting variation lower the risk but do not remove it.
To keep it low:

- Use a number you can afford to lose, not the main business number.
- Message only people who gave you their number (enquiries, students). Many reports from people who
  didn't ask for messages lead to a ban quickly.
- Keep campaigns small (tens, not thousands, a day) and keep the delays at their defaults or longer.

For large volumes, the official WhatsApp Business Platform (Cloud API) is the safe route. It
uses approved templates and is paid per conversation.
