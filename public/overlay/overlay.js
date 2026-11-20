// Gemeinsame Helfer für alle Overlays
let S = null;          // letzter Zustand
let clockOffset = 0;   // Server-Zeit minus Client-Zeit

function connect(onState) {
  const handle = d => { S = d; clockOffset = d.now - Date.now(); onState(S); };
  // Eingebettet in layer1/layer2: gemeinsame Verbindung des Eltern-Fensters nutzen
  if (window.parent !== window && window.parent.hub) { window.parent.hub.add(handle); return; }
  const es = new EventSource('/events');
  es.onmessage = e => handle(JSON.parse(e.data));
  es.onerror = () => { /* EventSource verbindet automatisch neu */ };
}

function clockSecs() {
  if (!S) return 0;
  const c = S.clock;
  return c.base + (c.running ? (Date.now() + clockOffset - c.startedAt) / 1000 : 0);
}
function fmtClock(s) {
  s = Math.max(0, Math.floor(s));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
const team = id => S.teams.find(t => t.id === id) || { name: '?', short: '?', color: '#888', logo: '' };
const curMatch = () => S.matches.find(m => m.id === S.currentMatch);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Eigenes Logo (t.logo = URL) oder generiertes Platzhalter-Wappen
const logoUrl = t => t.logo || `/logo/${t.id}.svg?v=${encodeURIComponent(t.color + t.short)}`;
const badge = t => `<img class="logo" src="${esc(logoUrl(t))}">`;
const param = k => new URLSearchParams(location.search).get(k);
