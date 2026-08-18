'use strict';

const S = require('./lib/supabase');

const MAX_FILES = parseInt(process.env.MAX_FILES || '30', 10);
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '50', 10);

/** Dateinamen entschärfen: keine Pfade, keine Sonderzeichen, nicht zu lang. */
function safeName(name) {
  const base = String(name || 'datei').split(/[\\/]/).pop();
  const cleaned = base.replace(/[^\w.\-]+/g, '_').replace(/_{2,}/g, '_');
  return (cleaned || 'datei').slice(0, 120);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return S.json({ error: 'Methode nicht erlaubt' }, 405);
  if (!S.configured()) return S.json({ error: 'Server nicht konfiguriert (Supabase fehlt).' }, 500);

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return S.json({ error: 'Ungültige Anfrage.' }, 400);
  }

  const name = String(payload.name || '').trim().slice(0, 120) || 'Unbekannt';
  const contact = String(payload.contact || '').trim().slice(0, 200);
  const message = String(payload.message || '').trim().slice(0, 20000);
  const incoming = Array.isArray(payload.files) ? payload.files : [];

  if (!contact) {
    return S.json({ error: 'Bitte eine E-Mail-Adresse oder Telefonnummer angeben.' }, 400);
  }
  if (!message && incoming.length === 0) {
    return S.json({ error: 'Bitte eine Nachricht schreiben oder eine Datei anhängen.' }, 400);
  }
  if (incoming.length > MAX_FILES) {
    return S.json({ error: `Maximal ${MAX_FILES} Dateien pro Ticket.` }, 400);
  }
  for (const f of incoming) {
    if (Number(f.size) > MAX_FILE_MB * 1024 * 1024) {
      return S.json({ error: `Datei "${f.name}" ist größer als ${MAX_FILE_MB} MB.` }, 400);
    }
  }

  const id = S.newId();

  // Dateiliste vorbereiten: eindeutiger Speichername je Datei
  const files = incoming.map((f, i) => ({
    name: safeName(f.name),
    stored: `${String(i).padStart(3, '0')}-${safeName(f.name)}`,
    size: Number(f.size) || 0,
  }));

  try {
    await S.dbInsert({
      id,
      name,
      contact,
      message,
      files,
      created_at: new Date().toISOString(),
      complete: files.length === 0,
      pushed: false,
    });

    const uploads = [];
    for (const f of files) {
      uploads.push({ stored: f.stored, url: await S.signedUploadUrl(`${id}/${f.stored}`) });
    }

    S.cleanup().catch(() => {});
    return S.json({ id, uploads });
  } catch (e) {
    console.error('create-ticket:', e.message);
    return S.json({ error: 'Ticket konnte nicht angelegt werden.' }, 500);
  }
};
