'use strict';

const S = require('./lib/supabase');

/** Ticket-ID aus /ticket/<id> bzw. ?id=<id> holen. */
function idFrom(event) {
  const q = (event.queryStringParameters || {}).id;
  if (q) return q;
  const parts = String(event.path || '').split('/').filter(Boolean);
  return parts[parts.length - 1] === 'ticket' ? '' : parts[parts.length - 1];
}

exports.handler = async (event) => {
  if (!S.configured()) {
    return S.html(S.page('Nicht konfiguriert',
      '<h1>Server nicht konfiguriert</h1><div class="card"><p>Die Supabase-Zugangsdaten fehlen.</p></div>'), 500);
  }

  const id = idFrom(event);
  if (!id) return S.notFound();

  const t = await S.dbGet(id).catch(() => null);
  if (!t) return S.notFound();

  // Erstes Öffnen festhalten – ab hier läuft die Aufbewahrungsfrist
  let openedAt = t.opened_at;
  if (!openedAt) {
    openedAt = new Date().toISOString();
    await S.dbUpdate(id, { opened_at: openedAt }).catch(() => {});
  }
  const deleteAt = new Date(new Date(openedAt).getTime()
    + S.DELETE_AFTER_DAYS * 86400_000).toISOString();

  // Download-Adressen erzeugen (zeitlich begrenzt gültig)
  const rows = [];
  for (const f of t.files || []) {
    const url = await S.signedDownloadUrl(`${id}/${f.stored}`);
    rows.push(url
      ? `<li>📄 <a href="${S.esc(url)}" download="${S.esc(f.name)}">${S.esc(f.name)}</a>
         <span class="hint">${S.fmtSize(f.size)}</span></li>`
      : `<li>📄 ${S.esc(f.name)} <span class="hint">– Datei nicht mehr verfügbar</span></li>`);
  }

  const body = `
<h1>Ticket von ${S.esc(t.name)}</h1>
<div class="card">
  <p class="meta">Eingegangen am ${S.fmtDate(t.created_at)}</p>
  ${t.message ? `<label>Nachricht</label><div class="msgbox">${S.esc(t.message)}</div>` : ''}
  ${rows.length ? `<label>Angehängte Dokumente (${rows.length})</label>
     <ul class="files">${rows.join('')}</ul>` : ''}
  ${t.complete === false ? '<p class="hint">⚠ Der Upload war beim Absenden noch nicht abgeschlossen.</p>' : ''}
  <p class="hint" style="margin-top:1.2rem">
    Wird automatisch gelöscht am ${S.fmtDate(deleteAt)}
    (${S.DELETE_AFTER_DAYS} Tage nach dem ersten Öffnen).
  </p>
</div>`;

  S.cleanup().catch(() => {});
  return S.html(S.page(`Ticket von ${t.name}`, body));
};
