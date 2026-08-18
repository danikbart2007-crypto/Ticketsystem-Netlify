'use strict';
/* End-to-End-Test der Netlify-Functions gegen den nachgebauten Supabase-Server. */

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_KEY = 'testkey';
process.env.SUPABASE_BUCKET = 'ticket-files';
process.env.ADMIN_KEY = 'geheimerAdminKey123';
process.env.PUBLIC_BASE_URL = 'https://tickets.example.com';
process.env.DELETE_AFTER_DAYS = '50';
// Telegram bewusst nicht gesetzt -> Push schlägt fehl, muss sauber behandelt werden

const { server, db, storage } = require('./mock-supabase');

const create = require('../netlify/functions/create-ticket').handler;
const finalize = require('../netlify/functions/finalize-ticket').handler;
const ticket = require('../netlify/functions/ticket').handler;
const admin = require('../netlify/functions/admin').handler;
const S = require('../netlify/functions/lib/supabase');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [OK]     ${name}`); }
  else { fail++; console.log(`  [FEHLER] ${name} ${extra}`); }
}

const ev = (over = {}) => ({ httpMethod: 'GET', headers: { host: 'tickets.example.com' },
  path: '/', queryStringParameters: {}, body: null, ...over });

(async () => {
  await new Promise((r) => server.listen(54321, r));

  console.log('\n1) Ticket mit zwei Dateien anlegen');
  let res = await create(ev({ httpMethod: 'POST', body: JSON.stringify({
    name: 'Max Mustermann',
    message: 'Der Beamer im Proberaum ist defekt.',
    files: [{ name: 'protokoll.pdf', size: 1234 }, { name: 'foto vom schaden.JPG', size: 900 }],
  }) }));
  const created = JSON.parse(res.body);
  check('Ticket angelegt', res.statusCode === 200 && created.id, res.body);
  check('Zwei Upload-Adressen erhalten', created.uploads?.length === 2);
  check('Dateiname entschärft', created.uploads[1].stored.includes('foto_vom_schaden.JPG'),
    created.uploads[1]?.stored);

  console.log('\n2) Dateien direkt hochladen (wie der Browser es tut)');
  for (const [i, up] of created.uploads.entries()) {
    const r = await fetch(up.url, { method: 'PUT', body: `Inhalt Datei ${i}` });
    check(`Upload ${i + 1} erfolgreich`, r.ok, `HTTP ${r.status}`);
  }
  check('Dateien liegen im Speicher', storage.size === 2, `${storage.size}`);

  console.log('\n3) Ticket abschließen (Push schlägt mangels Telegram-Token fehl)');
  res = await finalize(ev({ httpMethod: 'POST',
    body: JSON.stringify({ id: created.id, failed: [] }) }));
  const fin = JSON.parse(res.body);
  check('Abschluss ohne Absturz', res.statusCode === 200 && fin.ok === true, res.body);
  check('Fehlgeschlagener Push wird gemeldet', fin.pushed === false);
  check('Ticket als vollständig markiert', db.get(created.id).complete === true);

  console.log('\n4) Ticket-Ansicht öffnen');
  res = await ticket(ev({ path: `/ticket/${created.id}` }));
  check('Seite wird ausgeliefert', res.statusCode === 200);
  check('Name erscheint', res.body.includes('Max Mustermann'));
  check('Nachricht erscheint', res.body.includes('Beamer im Proberaum'));
  check('Beide Downloads verlinkt', (res.body.match(/object\/download/g) || []).length === 2);
  check('Löschdatum wird angezeigt', res.body.includes('Wird automatisch gelöscht am'));
  check('Öffnungszeitpunkt gespeichert', Boolean(db.get(created.id).opened_at));

  const firstOpen = db.get(created.id).opened_at;
  await new Promise((r) => setTimeout(r, 20));
  await ticket(ev({ path: `/ticket/${created.id}` }));
  check('Öffnungszeitpunkt bleibt beim ersten Öffnen stehen',
    db.get(created.id).opened_at === firstOpen);

  console.log('\n5) Sicherheit');
  res = await ticket(ev({ path: '/ticket/gibtsnicht123' }));
  check('Unbekanntes Ticket -> 404', res.statusCode === 404);
  res = await admin(ev({ path: '/admin/falscherKey' }));
  check('Falscher Admin-Schlüssel -> 404', res.statusCode === 404);
  res = await admin(ev({ path: '/admin/' }));
  check('Fehlender Admin-Schlüssel -> 404', res.statusCode === 404);
  res = await create(ev({ httpMethod: 'GET' }));
  check('Falsche Methode -> 405', res.statusCode === 405);
  res = await create(ev({ httpMethod: 'POST', body: JSON.stringify({ name: 'X', files: [] }) }));
  check('Leeres Ticket abgelehnt', res.statusCode === 400);
  res = await create(ev({ httpMethod: 'POST', body: JSON.stringify({
    name: 'X', message: 'y', files: [{ name: 'riesig.zip', size: 99 * 1024 * 1024 }] }) }));
  check('Zu große Datei abgelehnt', res.statusCode === 400);
  res = await ticket(ev({ path: '/ticket/../../etc/passwd' }));
  check('Pfad-Ausbruch wirkungslos', res.statusCode === 404);

  console.log('\n6) Admin-Übersicht');
  res = await admin(ev({ path: `/admin/${process.env.ADMIN_KEY}` }));
  check('Übersicht erreichbar', res.statusCode === 200);
  check('Ticket gelistet', res.body.includes('Max Mustermann'));
  check('Fehlzustellung markiert', res.body.includes('Push nicht zugestellt'));
  check('Warnung mit Anzahl', res.body.includes('1 Ticket(s) konnten nicht'));
  check('Öffnungsstatus sichtbar', res.body.includes('geöffnet am'));

  console.log('\n7) Löschregel nach 50 Tagen');
  // Ticket A: vor 51 Tagen geöffnet -> muss gelöscht werden
  const old = { id: 'altesTicket', name: 'Alt', message: 'alt', complete: true, pushed: true,
    files: [{ name: 'a.txt', stored: '000-a.txt', size: 5 }],
    created_at: new Date(Date.now() - 60 * 86400e3).toISOString(),
    opened_at: new Date(Date.now() - 51 * 86400e3).toISOString() };
  db.set(old.id, old);
  storage.set('ticket-files/altesTicket/000-a.txt', Buffer.from('alt'));
  // Ticket B: vor 49 Tagen geöffnet -> muss bleiben
  db.set('fastAlt', { ...old, id: 'fastAlt',
    opened_at: new Date(Date.now() - 49 * 86400e3).toISOString() });
  // Ticket C: nie geöffnet, sehr alt -> muss bleiben
  db.set('nieGeoeffnet', { ...old, id: 'nieGeoeffnet', opened_at: null });

  const r = await S.cleanup(true);
  check('Genau ein Ticket gelöscht', r.deleted === 1, `gelöscht: ${r.deleted}`);
  check('Abgelaufenes Ticket entfernt', !db.has('altesTicket'));
  check('Dessen Datei entfernt', !storage.has('ticket-files/altesTicket/000-a.txt'));
  check('49 Tage altes Ticket bleibt', db.has('fastAlt'));
  check('Ungeöffnetes Ticket bleibt', db.has('nieGeoeffnet'));
  res = await ticket(ev({ path: '/ticket/altesTicket' }));
  check('Gelöschtes Ticket -> 404', res.statusCode === 404);

  console.log('\n8) Teil-Upload: eine Datei scheitert im Browser');
  res = await create(ev({ httpMethod: 'POST', body: JSON.stringify({
    name: 'Teil', message: 'test',
    files: [{ name: 'gut.txt', size: 10 }, { name: 'kaputt.txt', size: 10 }] }) }));
  const partial = JSON.parse(res.body);
  await fetch(partial.uploads[0].url, { method: 'PUT', body: 'ok' });
  res = await finalize(ev({ httpMethod: 'POST', body: JSON.stringify({
    id: partial.id, failed: [partial.uploads[1].stored] }) }));
  check('Abschluss trotz Fehlupload', res.statusCode === 200);
  check('Nur erfolgreiche Datei bleibt gelistet', db.get(partial.id).files.length === 1);
  res = await ticket(ev({ path: `/ticket/${partial.id}` }));
  check('Ansicht zeigt eine Datei', (res.body.match(/object\/download/g) || []).length === 1);

  console.log(`\nErgebnis: ${pass} bestanden, ${fail} fehlgeschlagen\n`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
