'use strict';

/**
 * Gemeinsame Hilfsfunktionen für alle Netlify-Functions.
 * Sprechen direkt mit der Supabase-REST- und Storage-API (kein npm-Paket nötig).
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'ticket-files';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DELETE_AFTER_DAYS = parseInt(process.env.DELETE_AFTER_DAYS || '50', 10);

const dbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

/** Zufällige, nicht erratbare Ticket-ID. */
function newId(bytes = 12) {
  return require('crypto').randomBytes(bytes).toString('base64url');
}

/* ---------------------------------------------------------------- Datenbank */

async function dbInsert(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/tickets`, {
    method: 'POST',
    headers: { ...dbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`DB-Insert fehlgeschlagen (${r.status}): ${await r.text()}`);
  return (await r.json())[0];
}

async function dbGet(id) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/tickets?id=eq.${encodeURIComponent(id)}&select=*`,
    { headers: dbHeaders });
  if (!r.ok) throw new Error(`DB-Abfrage fehlgeschlagen (${r.status}): ${await r.text()}`);
  const rows = await r.json();
  return rows[0] || null;
}

async function dbUpdate(id, patch) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/tickets?id=eq.${encodeURIComponent(id)}`,
    { method: 'PATCH', headers: dbHeaders, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error(`DB-Update fehlgeschlagen (${r.status}): ${await r.text()}`);
}

async function dbList() {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/tickets?select=*&order=created_at.desc&limit=500`,
    { headers: dbHeaders });
  if (!r.ok) throw new Error(`DB-Liste fehlgeschlagen (${r.status}): ${await r.text()}`);
  return r.json();
}

async function dbDelete(ids) {
  if (!ids.length) return;
  const list = ids.map((i) => `"${i}"`).join(',');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/tickets?id=in.(${encodeURIComponent(list)})`,
    { method: 'DELETE', headers: dbHeaders });
  if (!r.ok) throw new Error(`DB-Löschen fehlgeschlagen (${r.status}): ${await r.text()}`);
}

/* ----------------------------------------------------------------- Speicher */

/** Signierte Upload-Adresse: Der Browser lädt damit direkt zu Supabase hoch. */
async function signedUploadUrl(path) {
  const r = await fetch(
    `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${encodeURI(path)}`,
    { method: 'POST', headers: dbHeaders, body: '{}' });
  if (!r.ok) throw new Error(`Upload-Signatur fehlgeschlagen (${r.status}): ${await r.text()}`);
  const data = await r.json();
  return `${SUPABASE_URL}/storage/v1${data.url}`;
}

/** Signierte Download-Adresse, standardmäßig 2 Stunden gültig. */
async function signedDownloadUrl(path, expiresIn = 7200) {
  const r = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${encodeURI(path)}`,
    { method: 'POST', headers: dbHeaders, body: JSON.stringify({ expiresIn }) });
  if (!r.ok) return null;
  const data = await r.json();
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

async function deleteFiles(paths) {
  if (!paths.length) return;
  await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE', headers: dbHeaders, body: JSON.stringify({ prefixes: paths }),
  }).catch(() => {});
}

/* ------------------------------------------------------------- Aufräumlogik */

let lastCleanup = 0;

/**
 * Löscht Tickets, deren Öffnung länger als DELETE_AFTER_DAYS zurückliegt.
 * Ungeöffnete Tickets bleiben bewusst erhalten.
 * Läuft nebenbei bei Seitenaufrufen, höchstens einmal pro Stunde je Instanz.
 */
async function cleanup(force = false) {
  if (!configured()) return { deleted: 0, skipped: true };
  if (!force && Date.now() - lastCleanup < 3600_000) return { deleted: 0, skipped: true };
  lastCleanup = Date.now();

  const cutoff = new Date(Date.now() - DELETE_AFTER_DAYS * 86400_000).toISOString();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/tickets?opened_at=lt.${cutoff}&select=id,files`,
    { headers: dbHeaders });
  if (!r.ok) return { deleted: 0, skipped: true };
  const rows = await r.json();
  if (!rows.length) return { deleted: 0, skipped: false };

  const paths = [];
  for (const row of rows) {
    for (const f of row.files || []) paths.push(`${row.id}/${f.stored}`);
  }
  await deleteFiles(paths);
  await dbDelete(rows.map((r2) => r2.id));
  return { deleted: rows.length, skipped: false };
}

/* --------------------------------------------------------------- Benachrichtigung */

async function sendTelegram(ticketId, name, numFiles, baseUrl) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  const link = `${baseUrl.replace(/\/$/, '')}/ticket/${ticketId}`;
  let text = `🎫 Neues Ticket von ${name}`;
  if (numFiles) text += `\n📎 ${numFiles} Datei(en) angehängt`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    reply_markup: { inline_keyboard: [[{ text: 'Ticket öffnen', url: link }]] },
  };
  try {
    let r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.status === 400) {
      // Button-Adresse abgelehnt (z. B. beim lokalen Test) -> Link in den Text
      delete payload.reply_markup;
      payload.text = `${text}\n${link}`;
      r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    return r.ok;
  } catch (e) {
    console.error('Telegram-Versand fehlgeschlagen:', e.message);
    return false;
  }
}

/* ------------------------------------------------------------------ Ausgabe */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' Uhr';
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const STYLE = `
:root{--bg:#10141c;--card:#1a2130;--line:#2b3446;--text:#e8ecf4;--muted:#93a0b8;--accent:#ffd166;--accent-ink:#1a1405}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;justify-content:center;padding:2rem 1rem 4rem}
main{width:100%;max-width:560px}
.brand{font-size:.8rem;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-bottom:.4rem}
h1{font-size:1.6rem;margin:0 0 1.5rem;line-height:1.25}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.4rem;margin-bottom:1rem}
label{display:block;font-size:.9rem;color:var(--muted);margin:1rem 0 .35rem}
label:first-of-type{margin-top:0}
input[type=text],textarea{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--text);padding:.65rem .75rem;font:inherit}
textarea{min-height:130px;resize:vertical}
input:focus,textarea:focus,.filebox:focus-within{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
.filebox{border:1.5px dashed var(--line);border-radius:10px;padding:1rem;text-align:center;color:var(--muted);font-size:.9rem}
.filebox input{width:100%;color:var(--muted)}
.hint{font-size:.8rem;color:var(--muted);margin-top:.4rem}
button,.btn{display:inline-block;margin-top:1.4rem;width:100%;background:var(--accent);color:var(--accent-ink);border:0;border-radius:10px;padding:.8rem 1rem;font:inherit;font-weight:700;cursor:pointer;text-align:center;text-decoration:none}
button:hover,.btn:hover{filter:brightness(1.07)}
button[disabled]{opacity:.6;cursor:default}
.error{background:#3a1c22;border:1px solid #6e2f3a;color:#ffb4c0;border-radius:8px;padding:.7rem .9rem;font-size:.9rem;margin-bottom:1rem}
.msgbox{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.9rem;line-height:1.5}
ul.files{list-style:none;padding:0;margin:.4rem 0 0}
ul.files li{margin:.35rem 0}
ul.files a{color:var(--accent);text-decoration:none;word-break:break-all}
ul.files a:hover{text-decoration:underline}
.meta{color:var(--muted);font-size:.85rem;margin-bottom:1rem}
progress{width:100%;height:.6rem;margin-top:1rem}
`;

function page(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main><p class="brand">Ticketsystem</p>${bodyHtml}</main></body></html>`;
}

function html(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body,
  };
}

function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

function notFound() {
  return html(page('Nicht gefunden',
    `<h1>Nicht gefunden</h1><div class="card"><p>Unter dieser Adresse liegt nichts.
     Möglicherweise wurde das Ticket bereits gelöscht oder der Link ist unvollständig.</p>
     <a class="btn" href="/">Zur Startseite</a></div>`), 404);
}

/** Zeitsicherer Vergleich für den Admin-Schlüssel. */
function keyMatches(given) {
  if (!ADMIN_KEY || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length) return false;
  return require('crypto').timingSafeEqual(a, b);
}

function baseUrlFrom(event) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.URL) return process.env.URL.replace(/\/$/, '');
  const proto = (event.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = event.headers.host || 'localhost';
  return `${proto}://${host}`;
}

module.exports = {
  configured, newId, dbInsert, dbGet, dbUpdate, dbList, dbDelete,
  signedUploadUrl, signedDownloadUrl, deleteFiles, cleanup, sendTelegram,
  esc, fmtDate, fmtSize, page, html, json, notFound, keyMatches, baseUrlFrom,
  DELETE_AFTER_DAYS, BUCKET,
};
