# SIM & WhatsApp Desk — panel backend

The SIM & WhatsApp Desk (phones, SIMs, WhatsApp numbers, recharge validity, reminders, spend) stores its data in the admin panel's MySQL database and reads call stats from Caller IQ's `caller_iq_calls` table. Frontend: `sim-whatsapp-desk/react-app`.

## Upload

Upload this folder to the panel as `react-api/api/sim-desk/`, next to `api/caller-iq/`:

| File | |
|---|---|
| `desk.php` | The API. POST JSON `{ action, ... }`. Uses `config/database.php` and `middleware/auth.php` like the caller-iq files. |
| `desk_lib.php` | Storage, validation, Caller IQ stats, reminder rules. |
| `desk_cron.php` | Daily reminder email (command line only). |

Tables `sim_desk_slices`, `sim_desk_events` and `sim_desk_meta` are created on first use.

**Who can use it:** signed-in panel users with the `caller_iq` permission (`require_jwt()` + `require_permission('caller_iq', …)`).

## Frontend

In `react-app`, create `.env.production`:

```
VITE_API_STYLE=panel
VITE_API_URL=https://cit3.internshipstudio.com/admin/react-api/api/sim-desk/desk.php
VITE_AUTH_TOKEN_KEY=<the localStorage key holding the panel's login token>
VITE_POLL_MS=30000
VITE_API_ACTIONS=true
```

Then run `npm run build` and upload `dist/` to a folder on the **same domain**, for example `admin/sim-desk/`. The desk then reads the panel's sign-in token from the browser, so anyone signed in to the panel can open it. If the token is missing or expired, the desk says so.

## Daily reminders

Add this in your hosting control panel's Cron Jobs:

```
0 9 * * *  php /home/<account>/…/react-api/api/sim-desk/desk_cron.php
```

It sends today's due reminders to the email address and the WhatsApp numbers saved in the desk's **Send reminders** dialog. Days with nothing due are skipped, and it never sends twice on the same day. Add `--force` to send a test. Mail goes through PHP `mail()`. Set `define('DESK_MAIL_FROM', 'desk@internshipstudio.com');` in `config/database.php` to choose the From address.

### WhatsApp reminders

WhatsApp goes through the Caller IQ WhatsApp bridge (`calliq2/whatsapp-bridge`, `POST /api/whatsapp/send-single`). Add to `config/database.php`:

```php
define('DESK_WA_BRIDGE_URL', 'https://<where the bridge runs>');   // the panel's server must be able to reach it
define('DESK_WA_BRIDGE_KEY', '<the bridge BRIDGE_KEY>');
```

The messages come from the WhatsApp account linked to the bridge. Without these two settings the desk's **Send on WhatsApp** button says WhatsApp isn't set up, and the cron sends email only.

## Caller IQ data

`load` fills each SIM's `calls` / `talkMins` (last 30 days, hidden test phones excluded) from `caller_iq_calls`:

1. **By the SIM's own number:** `sim_msisdn` (the number the network wrote to the card), matched against the desk SIM's number.
2. **Otherwise by phone + slot:** the Caller IQ phone the desk phone is linked to (`ciqDeviceId`, set in the phone's ⋯ menu → **Caller IQ phone**) plus the SIM's slot, matched against `device_id` + `sim_slot`. The slot is the one the desk shows (SIM 1 / SIM 2); `Sim.ciqSlot` overrides it.

### Validity from the phone (USSD)

For SIMs in linked phones, `load` also adds `sim.ussd = { validTill, balance, checkedAt }`: the newest "valid till" the app's daily USSD check sent to `sim_status.php` for that phone + slot. When that date is later than the recharge logged on the desk, the desk and the reminders use it (marked **📶 phone** in the validity table).

`sim_status.php` isn't in this repo, so its table is looked up at runtime: the first of `caller_iq_sim_status`, `caller_iq_ussd`, `caller_iq_sims`, `sim_status` that has `device_id`, `slot` (or `sim_slot`) and `valid_till` columns. **Check this against the live database.** If the table or columns are named differently, change `desk_ussd_status()` in `desk_lib.php`; until then the desk simply works without it.

The column names `sim_msisdn` / `sim_slot` come from what the app sends to `log_call.php`. **They have not been checked against the live table**, because `log_call.php` and `ciq_lib.php` are only on the server. The code looks the columns up at runtime, so if they're named differently the stats simply stay at 0 and nothing breaks. Rename them in `desk_call_stats()` in `desk_lib.php` once confirmed.

`sync` ("Connect Phone") and `devices` list the Caller IQ phones (`caller_iq_devices`) so a desk phone can be linked to one.

Not yet used: `checkin.php` (phone health). Its table isn't in this repo.

## API

| action | input | returns |
|---|---|---|
| `load` | | `{ phones, sims, was, payments, recurring, activity, calling, settings, community }` |
| `save` | `slice`, `body` (`{ items }`, the settings object, or `{ data }` for community) | `{ ok }`, or `400 { message }` if invalid |
| `me` | | `{ id, name }` |
| `sync` | | `{ syncedAt, devices }` |
| `devices` | | `{ devices: [{ deviceId, agent, team, lastCallAt }] }` |
| `send_reminders` | `to, subject, text, html, items` | `{ ok }` |
| `send_reminders_wa` | `to` (10-digit numbers), `text` | `{ ok, sent }`, or `400 { message }` with the bridge's reason |
| `event` | `name, payload` | `{ ok }` (audit log) |
| `events` | `limit?` | `{ events: [...] }` |
