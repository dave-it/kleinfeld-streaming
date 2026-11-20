// Eine einzige Server-Verbindung für alle eingebetteten Overlays einer Ebene
window.hub = (() => {
  const subs = []; let last = null;
  const es = new EventSource('/events');
  es.onmessage = e => { last = JSON.parse(e.data); subs.forEach(h => h(last)); };
  return { add(h) { subs.push(h); if (last) h(last); } };
})();
