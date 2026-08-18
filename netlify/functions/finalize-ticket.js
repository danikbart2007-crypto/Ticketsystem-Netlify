'use strict';

const S = require('./lib/supabase');

/**
 * Wird aufgerufen, nachdem der Browser alle Dateien hochgeladen hat.
 * Markiert das Ticket als vollständig und verschickt die Benachrichtigung.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return S.json({ error: 'Methode nicht erlaubt' }, 405);
  if (!S.configured()) return S.json({ error: 'Server nicht konfiguriert.' }, 500);

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return S.json({ error: 'Ungültige Anfrage.' }, 400);
  }

  const id = String(payload.id || '');
  const failed = Array.isArray(payload.failed) ? payload.failed : [];

  const ticket = await S.dbGet(id).catch(() => null);
  if (!ticket) return S.json({ error: 'Ticket nicht gefunden.' }, 404);

  // Dateien, die der Browser nicht hochladen konnte, aus der Liste nehmen
  let files = ticket.files || [];
  if (failed.length) files = files.filter((f) => !failed.includes(f.stored));

  const pushed = await S.sendTelegram(id, ticket.name, files.length, S.baseUrlFrom(event));

  await S.dbUpdate(id, { files, complete: true, pushed }).catch((e) => {
    console.error('finalize-ticket update:', e.message);
  });

  return S.json({ ok: true, pushed });
};
