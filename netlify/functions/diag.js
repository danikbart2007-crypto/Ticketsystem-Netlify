'use strict';

const S = require('./lib/supabase');

/**
 * Prüft Schritt für Schritt, ob die Supabase-Anbindung wirklich funktioniert:
 * Konfiguration -> Tabelle -> Spalten -> Schreiben -> Lesen -> Bucket ->
 * Upload -> Download -> Aufräumen. Nur mit ADMIN_KEY erreichbar.
 */
exports.handler = async (event) => {
  const key = (event.queryStringParameters || {}).key
    || String(event.path || '').split('/').filter(Boolean).pop();
  if (!S.keyMatches(key)) return S.notFound();

  const out = [];
  const ok = (m) => out.push(`[OK]      ${m}`);
  const bad = (m) => out.push(`[FEHLER]  ${m}`);
  const info = (m) => out.push(`          ${m}`);

  const url = process.env.SUPABASE_URL || '';
  const svc = process.env.SUPABASE_SERVICE_KEY || '';
  const bucket = process.env.SUPABASE_BUCKET || 'ticket-files';

  out.push('--- Konfiguration ---');
  url ? ok(`SUPABASE_URL gesetzt: ${url}`) : bad('SUPABASE_URL fehlt');
  if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url.replace(/\/$/, ''))) {
    info('Hinweis: erwartet wird die Form https://xxxx.supabase.co (ohne Pfad/Slash am Ende)');
  }
  if (!svc) bad('SUPABASE_SERVICE_KEY fehlt');
  else {
    ok(`SUPABASE_SERVICE_KEY gesetzt (Länge ${svc.length})`);
    try {
      const payload = JSON.parse(Buffer.from(svc.split('.')[1], 'base64').toString());
      payload.role === 'service_role'
        ? ok('Schlüsselrolle: service_role (richtig)')
        : bad(`Schlüsselrolle: ${payload.role} – es wird der service_role-Schlüssel benötigt, `
            + 'nicht der anon/public-Schlüssel!');
    } catch {
      info('Schlüsselrolle nicht lesbar – ggf. unvollständig kopiert.');
    }
  }
  info(`Bucket-Name: ${bucket}`);
  info(`Telegram konfiguriert: ${process.env.TELEGRAM_BOT_TOKEN
    && process.env.TELEGRAM_CHAT_ID ? 'ja' : 'nein'}`);

  if (!url || !svc) {
    return S.html(S.page('Diagnose', `<h1>Diagnose</h1><div class="card"><pre style="white-space:pre-wrap">${
      S.esc(out.join('\n'))}</pre></div>`));
  }

  const H = { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json' };
  const base = url.replace(/\/$/, '');
  const testId = `diagtest-${Date.now()}`;

  out.push('');
  out.push('--- Datenbank ---');
  try {
    const r = await fetch(`${base}/rest/v1/tickets?select=id&limit=1`, { headers: H });
    if (r.ok) ok('Tabelle "tickets" erreichbar');
    else {
      const t = await r.text();
      bad(`Tabelle nicht erreichbar (HTTP ${r.status}): ${t.slice(0, 300)}`);
      if (r.status === 404) info('-> SUPABASE.sql wurde vermutlich noch nicht ausgeführt.');
      if (r.status === 401) info('-> Schlüssel falsch oder unvollständig.');
    }
  } catch (e) {
    bad(`Keine Verbindung: ${e.message}`);
  }

  // Spalten prüfen
  try {
    const r = await fetch(`${base}/rest/v1/tickets?select=id,name,contact,message,files,`
      + 'created_at,opened_at,complete,pushed&limit=1', { headers: H });
    if (r.ok) ok('Alle erwarteten Spalten vorhanden (inkl. "contact")');
    else {
      const t = await r.text();
      if (/contact/i.test(t)) {
        bad('Spalte "contact" fehlt – bitte MIGRATION.sql im SQL-Editor ausführen.');
      } else {
        bad(`Spaltenprüfung fehlgeschlagen: ${t.slice(0, 300)}`);
      }
    }
  } catch (e) {
    bad(`Spaltenprüfung fehlgeschlagen: ${e.message}`);
  }

  // Schreiben und Lesen
  let written = false;
  try {
    const r = await fetch(`${base}/rest/v1/tickets`, {
      method: 'POST',
      headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({
        id: testId, name: 'Diagnose', contact: 'test@example.com',
        message: 'Testeintrag der Diagnose', files: [],
        created_at: new Date().toISOString(), complete: true, pushed: false,
      }),
    });
    if (r.ok) { ok('Schreiben in die Tabelle funktioniert'); written = true; }
    else {
      const t = await r.text();
      bad(`Schreiben fehlgeschlagen (HTTP ${r.status}): ${t.slice(0, 300)}`);
      if (/row-level security/i.test(t)) {
        info('-> Es wird der anon-Schlüssel statt des service_role-Schlüssels verwendet.');
      }
    }
  } catch (e) {
    bad(`Schreiben fehlgeschlagen: ${e.message}`);
  }

  if (written) {
    try {
      const r = await fetch(`${base}/rest/v1/tickets?id=eq.${testId}&select=*`, { headers: H });
      const rows = await r.json();
      rows.length ? ok('Zurücklesen funktioniert') : bad('Eintrag nicht wiederauffindbar');
    } catch (e) {
      bad(`Zurücklesen fehlgeschlagen: ${e.message}`);
    }
  }

  out.push('');
  out.push('--- Dateispeicher ---');
  try {
    const r = await fetch(`${base}/storage/v1/bucket/${bucket}`, { headers: H });
    if (r.ok) {
      const b = await r.json();
      ok(`Bucket "${bucket}" vorhanden`);
      if (b.public) info('Hinweis: Bucket ist öffentlich – empfohlen ist privat.');
    } else {
      bad(`Bucket "${bucket}" nicht gefunden (HTTP ${r.status})`);
      info('-> In Supabase unter Storage einen Bucket mit exakt diesem Namen anlegen.');
    }
  } catch (e) {
    bad(`Bucket-Prüfung fehlgeschlagen: ${e.message}`);
  }

  try {
    const signUrl = await S.signedUploadUrl(`${testId}/test.txt`);
    ok('Upload-Signatur wird ausgestellt');
    const up = await fetch(signUrl, {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'diagnose',
    });
    if (up.ok) {
      ok('Testdatei hochgeladen');
      const dl = await S.signedDownloadUrl(`${testId}/test.txt`);
      dl ? ok('Download-Adresse wird ausgestellt') : bad('Download-Adresse fehlgeschlagen');
      await S.deleteFiles([`${testId}/test.txt`]);
      ok('Testdatei wieder gelöscht');
    } else {
      bad(`Upload fehlgeschlagen (HTTP ${up.status}): ${(await up.text()).slice(0, 200)}`);
    }
  } catch (e) {
    bad(`Speichertest fehlgeschlagen: ${e.message}`);
  }

  if (written) {
    await fetch(`${base}/rest/v1/tickets?id=eq.${testId}`, { method: 'DELETE', headers: H })
      .then(() => ok('Testeintrag wieder gelöscht')).catch(() => {});
  }

  const failed = out.filter((l) => l.startsWith('[FEHLER]')).length;
  out.push('');
  out.push(failed ? `Ergebnis: ${failed} Problem(e) gefunden – siehe oben.`
    : 'Ergebnis: Alles in Ordnung. Tickets werden dauerhaft gespeichert.');

  return S.html(S.page('Diagnose',
    `<h1>Supabase-Diagnose</h1><div class="card"><pre style="white-space:pre-wrap;font-size:.85rem">${
      S.esc(out.join('\n'))}</pre></div>`));
};
