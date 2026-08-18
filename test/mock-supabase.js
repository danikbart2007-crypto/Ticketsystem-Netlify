'use strict';
/* Minimaler Nachbau der benutzten Supabase-Endpunkte – nur für Tests. */

const http = require('http');

const db = new Map();      // id -> row
const storage = new Map(); // "bucket/path" -> Buffer

function body(req) {
  return new Promise((res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };

  // ---------- Datenbank ----------
  if (p === '/rest/v1/tickets') {
    if (req.method === 'POST') {
      const row = JSON.parse((await body(req)).toString());
      row.opened_at = row.opened_at || null;
      db.set(row.id, row);
      return send(201, [row]);
    }
    if (req.method === 'GET') {
      const idFilter = u.searchParams.get('id');
      const openedLt = u.searchParams.get('opened_at');
      let rows = [...db.values()];
      if (idFilter?.startsWith('eq.')) rows = rows.filter((r) => r.id === idFilter.slice(3));
      if (openedLt?.startsWith('lt.')) {
        const cut = openedLt.slice(3);
        rows = rows.filter((r) => r.opened_at && r.opened_at < cut);
      }
      const order = u.searchParams.get('order');
      if (order?.startsWith('created_at.desc')) {
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      }
      return send(200, rows);
    }
    if (req.method === 'PATCH') {
      const idFilter = u.searchParams.get('id') || '';
      const patch = JSON.parse((await body(req)).toString());
      const row = db.get(idFilter.slice(3));
      if (row) Object.assign(row, patch);
      return send(204, '');
    }
    if (req.method === 'DELETE') {
      const inFilter = decodeURIComponent(u.searchParams.get('id') || '');
      const ids = inFilter.replace(/^in\.\(|\)$/g, '').split(',')
        .map((s) => s.replace(/^"|"$/g, ''));
      ids.forEach((i) => db.delete(i));
      return send(204, '');
    }
  }

  // ---------- Speicher ----------
  if (p.startsWith('/storage/v1/object/upload/sign/') && req.method === 'POST') {
    const path = p.replace('/storage/v1/object/upload/sign/', '');
    return send(200, { url: `/object/upload/put/${path}?token=testtoken` });
  }
  if (p.startsWith('/storage/v1/object/upload/put/') && req.method === 'PUT') {
    const path = p.replace('/storage/v1/object/upload/put/', '');
    storage.set(decodeURI(path), await body(req));
    return send(200, { Key: path });
  }
  if (p.startsWith('/storage/v1/object/sign/') && req.method === 'POST') {
    const path = decodeURI(p.replace('/storage/v1/object/sign/', ''));
    if (!storage.has(path)) return send(404, { error: 'not found' });
    return send(200, { signedURL: `/object/download/${path}?token=dl` });
  }
  if (p.startsWith('/storage/v1/object/download/') && req.method === 'GET') {
    const path = decodeURI(p.replace('/storage/v1/object/download/', ''));
    if (!storage.has(path)) return send(404, { error: 'not found' });
    res.writeHead(200);
    return res.end(storage.get(path));
  }
  if (p.match(/^\/storage\/v1\/object\/[^/]+$/) && req.method === 'DELETE') {
    const bucket = p.split('/').pop();
    const { prefixes } = JSON.parse((await body(req)).toString());
    prefixes.forEach((pre) => storage.delete(`${bucket}/${pre}`));
    return send(200, {});
  }

  send(404, { error: `unhandled ${req.method} ${p}` });
});

module.exports = { server, db, storage };

if (require.main === module) server.listen(54321);
