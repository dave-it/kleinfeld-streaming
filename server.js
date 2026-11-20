// Kleinfeld-Turnier Grafik-Server für vMix. Keine externen Abhängigkeiten.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8099;
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const PUBLIC = path.join(__dirname, 'public');

const GRAPHICS = ['scorebug', 'matchup', 'table', 'fixtures', 'results'];

// ---------- Anfangsdaten: 20 Teams, 4 Gruppen à 5, Jeder gegen Jeden ----------
function seed() {
  const groups = ['A', 'B', 'C', 'D'];
  const colors = ['#e63946', '#1d7de0', '#2a9d4b', '#f4a100', '#8e44ad'];
  const teams = [];
  groups.forEach((g, gi) => {
    for (let i = 0; i < 5; i++) {
      const n = gi * 5 + i + 1;
      teams.push({ id: n, name: `Team ${n}`, short: `T${String(n).padStart(2, '0')}`, color: colors[i], group: g, logo: '' });
    }
  });
  const matches = [];
  // Kreismethode für 5 Teams (+ Freilos) -> 5 Runden à 2 Spiele pro Gruppe
  for (let r = 0; r < 5; r++) {
    for (const g of groups) {
      const ids = teams.filter(t => t.group === g).map(t => t.id);
      const arr = [...ids, null];
      const rot = arr.slice(1);
      for (let k = 0; k < r; k++) rot.unshift(rot.pop());
      const ring = [arr[0], ...rot];
      for (let i = 0; i < 3; i++) {
        const a = ring[i], b = ring[5 - i];
        if (a != null && b != null) matches.push({ group: g, round: r + 1, home: a, away: b });
      }
    }
  }
  matches.forEach((m, i) => {
    m.id = i + 1;
    const slot = Math.floor(i / 2);
    const mins = 9 * 60 + slot * 15;
    m.time = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    m.field = `Platz ${(i % 2) + 1}`;
    m.hs = 0; m.as = 0; m.status = 'scheduled'; m.events = [];
  });
  return {
    tournament: { title: 'KLEINFELD CUP', subtitle: 'Fußballturnier' },
    teams, matches,
    currentMatch: 1,
    clock: { running: false, base: 0, startedAt: 0 },
    graphics: Object.fromEntries(GRAPHICS.map(g => [g, false])),
    tableGroup: 'A',
    alert: null,
  };
}

let state;
try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { state = seed(); }
state.clock.running = false; // nach Neustart Uhr anhalten
state.clock.base = clockSeconds();

function save() {
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(state)); } catch (e) { console.error('save', e.message); }
}

function clockSeconds() {
  const c = state.clock;
  return c.base + (c.running ? (Date.now() - c.startedAt) / 1000 : 0);
}

// ---------- Tabellen ----------
function computeTables() {
  const out = {};
  for (const t of state.teams) {
    (out[t.group] ||= []).push({ id: t.id, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 });
  }
  const find = id => Object.values(out).flat().find(r => r.id === id);
  for (const m of state.matches) {
    if (m.status !== 'finished') continue;
    const h = find(m.home), a = find(m.away);
    if (!h || !a) continue;
    // nur Gruppenspiele zählen (K.o./Eigene Spiele nicht)
    if (teamOf(m.home)?.group !== m.group || teamOf(m.away)?.group !== m.group) continue;
    h.p++; a.p++; h.gf += m.hs; h.ga += m.as; a.gf += m.as; a.ga += m.hs;
    if (m.hs > m.as) { h.w++; a.l++; h.pts += 3; }
    else if (m.hs < m.as) { a.w++; h.l++; a.pts += 3; }
    else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  const name = id => state.teams.find(t => t.id === id)?.name || '';
  for (const g in out) {
    out[g].forEach(r => r.gd = r.gf - r.ga);
    out[g].sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || name(x.id).localeCompare(name(y.id)));
  }
  return out;
}

// ---------- Aktionen ----------
const cur = () => state.matches.find(m => m.id === state.currentMatch);
const teamOf = id => state.teams.find(t => t.id === id);
const minuteNow = () => Math.floor(clockSeconds() / 60) + 1;

function act(a) {
  const m = a.matchId ? state.matches.find(x => x.id === a.matchId) : cur();
  switch (a.type) {
    case 'setCurrent': {
      if (!state.matches.some(x => x.id === a.matchId)) break;
      state.currentMatch = a.matchId;
      state.clock = { running: false, base: 0, startedAt: 0 };
      break;
    }
    case 'goal': {
      if (!m) break;
      const side = a.side === 'away' ? 'away' : 'home';
      const key = side === 'home' ? 'hs' : 'as';
      if ((a.delta || 1) < 0) {
        if (m[key] > 0) {
          m[key]--;
          const i = m.events.map(e => e.kind === 'goal' && e.side === side).lastIndexOf(true);
          if (i >= 0) m.events.splice(i, 1);
        }
      } else {
        m[key]++;
        const minute = m.id === state.currentMatch ? minuteNow() : 0;
        m.events.push({ kind: 'goal', side, player: a.player || '', minute });
        state.alert = { id: Date.now(), ts: Date.now(), kind: 'goal', side, matchId: m.id, team: teamOf(m[side === 'home' ? 'home' : 'away'])?.id, player: a.player || '', minute, hs: m.hs, as: m.as };
        if (m.status === 'scheduled') m.status = 'live';
      }
      break;
    }
    case 'card': {
      if (!m) break;
      const side = a.side === 'away' ? 'away' : 'home';
      const kind = a.color === 'red' ? 'red' : 'yellow';
      const minute = m.id === state.currentMatch ? minuteNow() : 0;
      m.events.push({ kind, side, player: a.player || '', minute });
      state.alert = { id: Date.now(), ts: Date.now(), kind, side, matchId: m.id, team: teamOf(side === 'home' ? m.home : m.away)?.id, player: a.player || '', minute, hs: m.hs, as: m.as };
      break;
    }
    case 'status': {
      if (m && ['scheduled', 'live', 'finished'].includes(a.status)) m.status = a.status;
      break;
    }
    case 'clock': {
      const c = state.clock;
      const now = Date.now();
      if (a.cmd === 'start' && !c.running) { c.running = true; c.startedAt = now; if (m && m.status === 'scheduled') m.status = 'live'; }
      else if (a.cmd === 'stop' && c.running) { c.base = clockSeconds(); c.running = false; }
      else if (a.cmd === 'reset') { state.clock = { running: false, base: 0, startedAt: 0 }; }
      else if (a.cmd === 'set') { const s = Math.max(0, Number(a.seconds) || 0); c.base = s; c.startedAt = now; }
      else if (a.cmd === 'add') { const s = Math.max(0, clockSeconds() + (Number(a.seconds) || 0)); c.base = s; c.startedAt = now; }
      break;
    }
    case 'graphic': {
      if (!GRAPHICS.includes(a.name)) break;
      state.graphics[a.name] = a.visible === 'toggle' ? !state.graphics[a.name] : !!a.visible;
      break;
    }
    case 'tableGroup': state.tableGroup = String(a.group || 'A'); break;
    case 'teams': {
      if (!Array.isArray(a.teams)) break;
      for (const nt of a.teams) {
        const t = teamOf(nt.id);
        if (t) Object.assign(t, { name: String(nt.name || t.name).slice(0, 40), short: String(nt.short || t.short).slice(0, 4).toUpperCase(), color: nt.color || t.color, logo: nt.logo || '' });
      }
      break;
    }
    case 'tournament': Object.assign(state.tournament, { title: a.title ?? state.tournament.title, subtitle: a.subtitle ?? state.tournament.subtitle }); break;
    case 'matchInfo': if (m) { if (a.time) m.time = a.time; if (a.field) m.field = a.field; } break;
    case 'addMatch': {
      if (!teamOf(a.home) || !teamOf(a.away) || a.home === a.away) break;
      const id = Math.max(0, ...state.matches.map(x => x.id)) + 1;
      state.matches.push({ id, group: String(a.label || 'Spiel').slice(0, 24), round: 0, custom: true, home: a.home, away: a.away,
        time: a.time || '--:--', field: a.field || 'Platz 1', hs: 0, as: 0, status: 'scheduled', events: [] });
      if (a.makeCurrent) { state.currentMatch = id; state.clock = { running: false, base: 0, startedAt: 0 }; }
      break;
    }
    case 'deleteMatch': {
      const x = state.matches.find(y => y.id === a.matchId);
      if (!x || !x.custom || x.id === state.currentMatch) break;
      state.matches = state.matches.filter(y => y.id !== x.id);
      break;
    }
    case 'reset': state = seed(); break;
  }
  save();
  broadcast();
}

// ---------- SSE ----------
const clients = new Set();
function payload() {
  return JSON.stringify({ ...state, tables: computeTables(), now: Date.now(), clockNow: clockSeconds() });
}
function broadcast() {
  const data = `data: ${payload()}\n\n`;
  for (const res of clients) res.write(data);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function readBody(req) {
  return new Promise(res => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } }); });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${payload()}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(payload()); }
  if (p === '/api/action' && req.method === 'POST') { act(await readBody(req)); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }

  // Komfort-URLs (GET) für vMix-Shortcuts / Stream Deck
  let m;
  if ((m = p.match(/^\/api\/graphic\/(\w+)\/(show|hide|toggle)$/))) {
    act({ type: 'graphic', name: m[1], visible: m[2] === 'toggle' ? 'toggle' : m[2] === 'show' });
    return res.end('ok');
  }
  if ((m = p.match(/^\/api\/goal\/(home|away)$/))) { act({ type: 'goal', side: m[1] }); return res.end('ok'); }
  if ((m = p.match(/^\/api\/clock\/(start|stop|reset)$/))) { act({ type: 'clock', cmd: m[1] }); return res.end('ok'); }

  // Platzhalter-Logo (Wappen in Teamfarbe)
  if ((m = p.match(/^\/logo\/(\d+)\.svg$/))) {
    const t = teamOf(Number(m[1])) || { color: '#888', short: '?' };
    const esc = s => String(s).replace(/[&<>"]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120"><defs><clipPath id="c"><path d="M50 4 L94 18 V60 C94 88 72 106 50 116 C28 106 6 88 6 60 V18 Z"/></clipPath></defs>
<path d="M50 4 L94 18 V60 C94 88 72 106 50 116 C28 106 6 88 6 60 V18 Z" fill="${esc(t.color)}"/>
<g clip-path="url(#c)"><path d="M-10 70 L110 20 V50 L-10 100Z" fill="#fff" opacity=".22"/><rect x="0" y="0" width="100" height="26" fill="#000" opacity=".18"/></g>
<path d="M50 4 L94 18 V60 C94 88 72 106 50 116 C28 106 6 88 6 60 V18 Z" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
<text x="50" y="75" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="${String(t.short).length > 3 ? 28 : 34}" fill="#fff" stroke="#000" stroke-opacity=".35" stroke-width="2" paint-order="stroke">${esc(t.short)}</text></svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
    return res.end(svg);
  }

  // statische Dateien
  let file = p === '/' ? '/control' : p;
  if (!path.extname(file)) file += '.html';
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log(`Steuerung:  http://localhost:${PORT}/control`);
  console.log(`Overlays:   http://localhost:${PORT}/overlay/scorebug.html  (und matchup, table, fixtures, results, alert)`);
});
