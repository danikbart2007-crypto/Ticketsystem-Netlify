'use strict';

const S = require('./lib/supabase');

/** Schlüssel aus /admin/<key> bzw. ?key=<key> holen. */
function keyFrom(event) {
  const q = (event.queryStringParameters || {}).key;
  if (q) return q;
  const parts = String(event.path || '').split('/').filter(Boolean);
  return parts[parts.length - 1] === 'admin' ? '' : parts[parts.length - 1];
}

exports.handler = async (event) => {
  if (!S.keyMatches(keyFrom(event))) return S.notFound();

  const cleaned = await S.cleanup(true).catch(() => ({ deleted: 0 }));
  const tickets = await S.dbList().catch(() => []);
  const unpushed = tickets.filter((t) => t.pushed === false).length;

  const cards = tickets.map((t) => {
    const flags = [];
    if (t.pushed === false) flags.push('<strong style="color:#ffb4c0">⚠ Push nicht zugestellt</strong>');
    if (t.complete === false) flags.push('<strong style="color:#ffb4c0">⚠ Upload unvollständig</strong>');
    if ((t.files || []).length) flags.push(`📎 ${t.files.length} Datei(en)`);
    flags.push(t.opened_at ? `geöffnet am ${S.fmtDate(t.opened_at)}` : 'noch ungeöffnet');

    const preview = t.message
      ? `<div class="msgbox" style="margin-top:.5rem;max-height:6.5em;overflow:hidden">${S.esc(t.message)}</div>`
      : '';
    return `<div class="card">
      <p class="meta">${S.fmtDate(t.created_at)} · ${flags.join(' · ')}</p>
      <strong>${S.esc(t.name)}</strong>${preview}
      <a class="btn" href="/ticket/${encodeURIComponent(t.id)}">Ticket öffnen</a>
    </div>`;
  }).join('');

  const body = `
<h1>Alle Tickets (${tickets.length})</h1>
${unpushed ? `<div class="error">⚠ ${unpushed} Ticket(s) konnten nicht per Push zugestellt werden – unten markiert.</div>` : ''}
${cleaned.deleted ? `<p class="hint">${cleaned.deleted} abgelaufene(s) Ticket(s) soeben gelöscht.</p>` : ''}
${tickets.length ? cards : '<div class="card"><p>Noch keine Tickets eingegangen.</p></div>'}
<p class="hint">Tickets werden ${S.DELETE_AFTER_DAYS} Tage nach dem ersten Öffnen automatisch gelöscht.
Ungeöffnete Tickets bleiben erhalten.</p>`;

  return S.html(S.page('Alle Tickets', body));
};
