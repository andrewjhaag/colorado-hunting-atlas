/*
 * Colorado Hunting Atlas for LG webOS TV
 * Map data: Andrew Haag's Colorado Hunting Atlas (ArcGIS Pro), exported for the TV
 *   (CPW, BLM Surface Management, Colorado State Land Board, CPW Species Activity Mapping)
 * Basemaps: USGS The National Map (public domain)
 * Written in plain ES5 so it runs on older TV browser engines.
 */
(function () {
  'use strict';

  // ---------- Settings ----------
  var VERSION = '0.1.1';
  var CO_BOUNDS = L.latLngBounds([36.99, -109.06], [41.01, -102.04]);
  var PAN_PX = 260;
  var HOLD_MS = 650;
  var HELP_FADE_MS = 25000;
  var MENU_IDLE_MS = 60000;
  var LABEL_MIN_ZOOM = 7.5;
  var LINE_HIT_PX = 12;
  var USGS = 'https://basemap.nationalmap.gov/arcgis/rest/services/';
  var BASEMAPS = [
    { name: 'USGS Topo', url: USGS + 'USGSTopo/MapServer/tile/{z}/{y}/{x}' },
    { name: 'USGS Imagery', url: USGS + 'USGSImageryOnly/MapServer/tile/{z}/{y}/{x}' },
    { name: 'USGS Shaded relief', url: USGS + 'USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}' }
  ];
  var GROUPS = ['Hunt units', 'Land & access', 'Elk habitat (CPW)', 'Mule deer habitat (CPW)', 'Species ranges (CPW)', 'Research'];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtNum(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  var errors = [];
  window.onerror = function (msg, src, line) { errors.push(msg + ' @' + line); setStatus('Error: ' + msg); };

  // ---------- Data store: the data files call HMAP.data() and HMAP.pop() ----------
  var store = {}, waiting = {}, pops = {}, popWait = {};
  window.HMAP = {
    data: function (key, fc) {
      prepData(fc);
      store[key] = fc;
      var w = waiting[key] || [];
      delete waiting[key];
      for (var i = 0; i < w.length; i++) { w[i](fc); }
    },
    pop: function (id, p) {
      pops[id] = p;
      var w = popWait[id] || [];
      delete popWait[id];
      for (var i = 0; i < w.length; i++) { w[i](p); }
    }
  };
  function loadScript(src, onerr) {
    var s = document.createElement('script');
    s.src = src;
    s.onerror = function () { if (onerr) { onerr(); } };
    document.head.appendChild(s);
  }
  function getData(key, cb) {
    if (store[key]) { cb(store[key]); return; }
    if (waiting[key]) { waiting[key].push(cb); return; }
    waiting[key] = [cb];
    loadScript('data/' + key + '.js', function () { delete waiting[key]; setStatus('Could not load ' + key); });
  }
  function getPop(id, cb) {
    if (pops[id]) { cb(pops[id]); return; }
    if (popWait[id]) { popWait[id].push(cb); return; }
    popWait[id] = [cb];
    loadScript('data/gmu/' + id + '.js', function () { delete popWait[id]; cb({ t: 'GMU ' + id, h: '<div class="poploading">Pop-up file missing.</div>' }); });
  }
  function bbGrow(c, bb) {
    if (typeof c[0] === 'number') {
      if (c[0] < bb[0]) { bb[0] = c[0]; } if (c[1] < bb[1]) { bb[1] = c[1]; }
      if (c[0] > bb[2]) { bb[2] = c[0]; } if (c[1] > bb[3]) { bb[3] = c[1]; }
      return;
    }
    for (var i = 0; i < c.length; i++) { bbGrow(c[i], bb); }
  }
  function prepData(fc) {
    for (var i = 0; i < fc.features.length; i++) {
      var f = fc.features[i], bb = [999, 999, -999, -999];
      bbGrow(f.geometry.coordinates, bb);
      f.bb = bb;
    }
  }

  // ---------- Preferences ----------
  var prefs = { on: null, base: 0, legend: true };
  try {
    var saved = JSON.parse(window.localStorage.getItem('cohunt.prefs') || 'null');
    if (saved) { prefs.on = saved.on || null; prefs.base = saved.base || 0; prefs.legend = saved.legend !== false; }
  } catch (e) { /* ignore */ }
  var prefsReady = false;
  function savePrefs() {
    if (!prefsReady) { return; }
    var on = {};
    for (var k in LAY) { if (LAY.hasOwnProperty(k)) { on[k] = !!LAY[k].on; } }
    prefs.on = on;
    try { window.localStorage.setItem('cohunt.prefs', JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }

  // ---------- Map ----------
  var map = L.map('map', {
    zoomControl: false, preferCanvas: true, keyboard: false, zoomSnap: 0.25, zoomDelta: 0.5,
    wheelPxPerZoomLevel: 110, minZoom: 6, maxZoom: 16, maxBounds: CO_BOUNDS.pad(0.5), inertia: false
  });
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('Basemap: USGS The National Map &middot; Data: CPW, BLM, Colorado State Land Board via the Colorado Hunting Atlas');
  L.control.scale({ imperial: true, metric: false, position: 'bottomleft', maxWidth: 220 }).addTo(map);
  var canvas = L.canvas({ padding: 0.2, tolerance: 0 });

  // ---------- Vector drawing: every vector layer is cut into tiles (geojson-vt) and drawn into one canvas tile layer,
  // so the TV only draws what is on screen ----------
  var VT_OPTS = { maxZoom: 16, tolerance: 3, extent: 4096, buffer: 64, indexMaxZoom: 5, indexMaxPoints: 100000 };
  map.createPane('vecPane').style.zIndex = 350;
  function drawTile(ctx, c, size) {
    var arr = [], k, s = size / 4096;
    for (k in LAY) { if (LAY.hasOwnProperty(k) && LAY[k].on && LAY[k].index) { arr.push(LAY[k]); } }
    arr.sort(function (a, b) { return a.m.z - b.m.z; });
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (var i = 0; i < arr.length; i++) {
      var E = arr[i], t = E.index.getTile(c.z, c.x, c.y);
      if (!t) { continue; }
      for (var f = 0; f < t.features.length; f++) {
        var ft = t.features[f], st = E.sty({ properties: ft.tags }), g = ft.geometry, p, q;
        ctx.beginPath();
        if (ft.type === 1) {
          for (p = 0; p < g.length; p++) { ctx.moveTo(g[p][0] * s + 7, g[p][1] * s); ctx.arc(g[p][0] * s, g[p][1] * s, 7, 0, 6.2832); }
        } else {
          for (p = 0; p < g.length; p++) {
            var ring = g[p];
            for (q = 0; q < ring.length; q++) { if (q) { ctx.lineTo(ring[q][0] * s, ring[q][1] * s); } else { ctx.moveTo(ring[q][0] * s, ring[q][1] * s); } }
            if (ft.type === 3) { ctx.closePath(); }
          }
        }
        if (ft.type !== 2 && st.fill && st.fillOpacity > 0) { ctx.globalAlpha = st.fillOpacity; ctx.fillStyle = st.fillColor; ctx.fill('evenodd'); }
        if (st.opacity > 0 && st.weight > 0) { ctx.globalAlpha = st.opacity; ctx.strokeStyle = st.color; ctx.lineWidth = st.weight; ctx.stroke(); }
      }
    }
    ctx.globalAlpha = 1;
  }
  var VecGrid = L.GridLayer.extend({
    createTile: function (coords) {
      var tile = document.createElement('canvas'), sz = this.getTileSize();
      tile.width = sz.x; tile.height = sz.y;
      drawTile(tile.getContext('2d'), coords, sz.x);
      return tile;
    }
  });
  var vec = new VecGrid({ pane: 'vecPane', updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 2, maxZoom: 16 });
  vec.addTo(map);
  var vecTimer = null;
  function redrawVec() { clearTimeout(vecTimer); vecTimer = setTimeout(function () { vec.redraw(); }, 40); }
  var baseLayer = null;
  function setBase(i) {
    prefs.base = (i + BASEMAPS.length) % BASEMAPS.length;
    if (baseLayer) { map.removeLayer(baseLayer); }
    baseLayer = L.tileLayer(BASEMAPS[prefs.base].url, { maxNativeZoom: 16, maxZoom: 16, keepBuffer: 3, updateWhenIdle: true });
    baseLayer.addTo(map);
    baseLayer.bringToBack();
    savePrefs();
    renderMenu();
  }
  function homeView() {
    map.fitBounds(CO_BOUNDS, { paddingTopLeft: [30, 60], paddingBottomRight: [30, 70] });
  }

  // ---------- Layers ----------
  var LAY = {};
  var LIST = [];   // manifest entries
  function styleFor(m) {
    return function (f) {
      var s = {}, k, c = f.properties ? f.properties.c : null;
      for (k in m.style) { if (m.style.hasOwnProperty(k)) { s[k] = m.style[k]; } }
      if (c && m.classes && m.classes[c]) {
        if (m.classes[c].fillColor) { s.fillColor = m.classes[c].fillColor; }
        if (m.classes[c].color) { s.color = m.classes[c].color; }
      }
      return s;
    };
  }
  function reorder() {
    if (hiLayer) { hiLayer.bringToFront(); }
    if (ptLayer) { ptLayer.bringToFront(); }
  }
  function setLayer(key, on) {
    var E = LAY[key];
    if (!E) { return; }
    E.on = on;
    savePrefs();
    if (!on) { redrawVec(); afterChange(); return; }
    if (E.index) { redrawVec(); afterChange(); return; }
    E.loading = true;
    renderMenu();
    setStatus('Loading ' + E.m.label + '\u2026');
    getData(key, function (fc) {
      setTimeout(function () {
        E.sty = styleFor(E.m);
        E.index = window.geojsonvt(fc, VT_OPTS);
        E.loading = false;
        if (E.on) { redrawVec(); }
        setStatus('');
        afterChange();
      }, 20);
    });
  }
  function afterChange() { updateLabels(); renderMenu(); renderLegend(); renderLayerLine(); }

  // GMU number labels
  var labelLayer = null, labelsShown = false;
  function updateLabels() {
    var want = LAY.gmu && LAY.gmu.on && store.gmu && map.getZoom() >= LABEL_MIN_ZOOM;
    if (want && !labelLayer) {
      labelLayer = L.layerGroup();
      var fs = store.gmu.features;
      for (var i = 0; i < fs.length; i++) {
        var p = fs[i].properties;
        labelLayer.addLayer(L.marker([p.lp[0], p.lp[1]], {
          interactive: false, keyboard: false,
          icon: L.divIcon({ className: 'gmulbl', html: String(p.n), iconSize: [60, 20], iconAnchor: [30, 10] })
        }));
      }
    }
    if (want && !labelsShown) { labelLayer.addTo(map); labelsShown = true; }
    if (!want && labelsShown) { map.removeLayer(labelLayer); labelsShown = false; }
  }
  map.on('zoomend', updateLabels);

  // ---------- Identify (pop-ups) ----------
  function pipRings(rings, x, y) {
    var inside = false;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) { inside = !inside; }
      }
    }
    return inside;
  }
  function segDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, t = 0;
    if (l2 > 0) { t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)); }
    var ex = a.x + t * dx - p.x, ey = a.y + t * dy - p.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  function lineHit(lines, p) {
    for (var l = 0; l < lines.length; l++) {
      var ln = lines[l], prev = null;
      for (var i = 0; i < ln.length; i++) {
        var q = map.latLngToContainerPoint([ln[i][1], ln[i][0]]);
        if (prev && segDist(p, prev, q) <= LINE_HIT_PX) { return true; }
        prev = q;
      }
    }
    return false;
  }
  function hitTest(latlng) {
    var x = latlng.lng, y = latlng.lat, hits = [], k;
    var p = map.latLngToContainerPoint(latlng);
    var p2 = map.containerPointToLatLng([p.x + LINE_HIT_PX, p.y + LINE_HIT_PX]);
    var tx = Math.abs(p2.lng - x), ty = Math.abs(p2.lat - y);
    for (k in LAY) {
      if (!LAY.hasOwnProperty(k) || !LAY[k].on || !store[k]) { continue; }
      var fs = store[k].features;
      for (var i = 0; i < fs.length; i++) {
        var f = fs[i], bb = f.bb, g = f.geometry, t = g.type, hit = false;
        if (x < bb[0] - tx || x > bb[2] + tx || y < bb[1] - ty || y > bb[3] + ty) { continue; }
        if (t === 'Polygon') { hit = pipRings(g.coordinates, x, y); }
        else if (t === 'MultiPolygon') {
          for (var j = 0; j < g.coordinates.length && !hit; j++) { hit = pipRings(g.coordinates[j], x, y); }
        }
        else if (t === 'LineString') { hit = lineHit([g.coordinates], p); }
        else if (t === 'MultiLineString') { hit = lineHit(g.coordinates, p); }
        else if (t === 'Point') {
          var q = map.latLngToContainerPoint([g.coordinates[1], g.coordinates[0]]);
          hit = Math.abs(q.x - p.x) < 16 && Math.abs(q.y - p.y) < 16;
        }
        if (hit) { hits.push({ m: LAY[k].m, f: f }); }
      }
    }
    hits.sort(function (a, b) { return a.m.rank - b.m.rank; });
    return hits;
  }
  function fillTpl(s, f, m) {
    var pr = f.properties || {};
    var label = (m.classes && pr.c && m.classes[pr.c]) ? m.classes[pr.c].label : (pr.c || '');
    return String(s).replace(/\{(\w+)\}/g, function (all, key) {
      if (key === 'label') { return esc(label); }
      if (key === 'a') { return pr.a != null ? fmtNum(pr.a) : ''; }
      return esc(pr[key] != null ? pr[key] : '');
    });
  }
  function tplCard(f, m) {
    var t = m.pop, h = "<div style='font-family:Segoe UI,Arial,sans-serif;background:#FFFFFF;border:1px solid #E3DED3;border-radius:10px;padding:8px 10px;'>";
    h += "<div style='color:#2F5D50;font-size:15px;font-weight:bold;font-family:Georgia,serif;margin-bottom:5px;'>" + fillTpl(t.title, f, m) + "</div>";
    h += "<table style='width:100%;border-collapse:collapse;font-size:11px;'>";
    for (var i = 0; i < t.rows.length; i++) {
      var v = fillTpl(t.rows[i][1], f, m);
      if (!v || /^(0 )?acres$/.test(v.replace(/^\s+/, ''))) { continue; }
      h += "<tr><td style='color:#7A7468;padding:3px 10px 3px 0;white-space:nowrap;vertical-align:top;border-top:1px solid #EFEBE3;'>" + esc(t.rows[i][0]) +
           "</td><td style='color:#2B2B2B;padding:3px 0;border-top:1px solid #EFEBE3;'>" + v + "</td></tr>";
    }
    h += '</table>';
    if (t.note) { h += "<div style='color:#9A9184;font-size:9px;margin-top:5px;'>" + esc(t.note) + '</div>'; }
    return h + '</div>';
  }
  function hitTitle(h) {
    if (h.m.key === 'gmu') { return 'GMU ' + h.f.properties.id; }
    if (h.m.pop) { return fillTpl(h.m.pop.title, h.f, h.m).replace(/&amp;/g, '&'); }
    return h.f.properties.t || h.m.label;
  }

  var popOpen = false, popHits = [], popSel = 0, hiLayer = null, ptLayer = null;
  function highlight(f) {
    if (hiLayer) { map.removeLayer(hiLayer); hiLayer = null; }
    if (!f || f.geometry.type === 'Point') { return; }
    hiLayer = L.geoJSON({ type: 'Feature', geometry: f.geometry, properties: {} }, {
      renderer: canvas, interactive: false, style: { color: '#00e5ff', weight: 4, opacity: 1, fill: false }
    }).addTo(map);
    hiLayer.bringToFront();
    if (ptLayer) { ptLayer.bringToFront(); }
  }
  function markPoint(ll) {
    if (ptLayer) { map.removeLayer(ptLayer); ptLayer = null; }
    if (!ll) { return; }
    ptLayer = L.circleMarker(ll, { renderer: canvas, interactive: false, radius: 9, color: '#ffffff', weight: 3, fillColor: '#00b8d4', fillOpacity: 1 }).addTo(map);
  }
  function identify(latlng) {
    var hits = hitTest(latlng);
    markPoint(latlng);
    if (!hits.length) { closePop(); markPoint(latlng); toast('Nothing here on the layers that are on'); return; }
    popHits = hits;
    popOpen = true;
    $('pop').className = 'panel';
    showHit(0);
  }
  function renderTabs() {
    var h = '<span class="tabcount">' + (popSel + 1) + ' of ' + popHits.length + '</span>';
    for (var i = 0; i < popHits.length; i++) {
      var lbl = popHits[i].m.key === 'gmu' ? 'GMU ' + popHits[i].f.properties.id : (popHits[i].m.lg || popHits[i].m.label);
      if (lbl.length > 30) { lbl = lbl.slice(0, 29) + '\u2026'; }
      h += '<span class="tab' + (i === popSel ? ' sel' : '') + '" data-i="' + i + '">' + esc(lbl) + '</span>';
    }
    $('poptabs').innerHTML = h;
  }
  function showHit(i) {
    popSel = (i + popHits.length) % popHits.length;
    var h = popHits[popSel];
    renderTabs();
    highlight(h.f);
    $('popbody').scrollTop = 0;
    $('poptitle').innerHTML = esc(hitTitle(h));
    if (h.m.key === 'gmu') {
      var id = h.f.properties.id;
      $('popzoom').innerHTML = '<div class="poploading">Loading GMU ' + esc(id) + '\u2026</div>';
      getPop(id, function (p) {
        if (!popOpen || popHits[popSel] !== h) { return; }
        $('poptitle').innerHTML = esc(p.t);
        $('popzoom').innerHTML = p.h;
      });
    } else if (h.m.pop) {
      $('popzoom').innerHTML = tplCard(h.f, h.m);
    } else {
      $('popzoom').innerHTML = h.f.properties.h || '';
    }
  }
  function closePop() {
    popOpen = false;
    $('pop').className = 'panel hidden';
    highlight(null);
    markPoint(null);
  }
  function scrollPop(dir) { $('popbody').scrollTop += dir * 260; }
  $('poptabs').onclick = function (e) {
    var t = e.target;
    while (t && t !== this && !t.getAttribute('data-i')) { t = t.parentNode; }
    if (t && t.getAttribute && t.getAttribute('data-i')) { showHit(parseInt(t.getAttribute('data-i'), 10)); }
  };
  function openUrl(u) {
    try {
      if (window.PalmServiceBridge) {
        var b = new window.PalmServiceBridge();
        b.onservicecallback = function () {};
        b.call('luna://com.webos.applicationManager/launch', JSON.stringify({ id: 'com.webos.app.browser', params: { target: u } }));
        toast('Opening in the TV web browser\u2026');
        return;
      }
    } catch (e) { /* fall through */ }
    try { var w = window.open(u, '_blank'); if (w) { w.opener = null; return; } } catch (e2) { /* fall through */ }
    toast(u);
  }
  $('popzoom').onclick = function (e) {
    var t = e.target;
    while (t && t !== this && t.tagName !== 'A') { t = t.parentNode; }
    if (t && t.tagName === 'A') {
      if (e.preventDefault) { e.preventDefault(); }
      var u = t.getAttribute('href') || '';
      if (/^https?:/i.test(u)) { openUrl(u); }
      else if (/^tel:/i.test(u)) { toast('Phone: ' + u.slice(4)); }
    }
  };

  // ---------- Layers menu ----------
  var MENU = [], menuOpen = false, menuSel = 1, menuIdle = null;
  function swatch(m) {
    var s = m.style, c = m.classes, fill = s.fill ? s.fillColor : 'transparent', line = s.opacity > 0 ? s.color : 'transparent', k;
    if (c) { for (k in c) { if (c.hasOwnProperty(k)) { if (c[k].fillColor) { fill = c[k].fillColor; } if (c[k].color) { line = c[k].color; } break; } } }
    return '<span class="sw" style="background:' + fill + ';border:3px solid ' + line + ';opacity:' + (s.fill ? Math.max(0.55, s.fillOpacity + 0.3) : 1) + '"></span>';
  }
  function buildMenu() {
    MENU = [{ type: 'head', label: 'Basemap' }];
    for (var b = 0; b < BASEMAPS.length; b++) { MENU.push({ type: 'base', i: b, label: BASEMAPS[b].name }); }
    for (var g = 0; g < GROUPS.length; g++) {
      var items = [];
      for (var i = 0; i < LIST.length; i++) { if (LIST[i].group === GROUPS[g]) { items.push(LIST[i]); } }
      if (!items.length) { continue; }
      items.sort(function (a, c) { return c.z - a.z; });
      MENU.push({ type: 'head', label: GROUPS[g] });
      for (var j = 0; j < items.length; j++) { MENU.push({ type: 'layer', key: items[j].key, label: items[j].label }); }
    }
    MENU.push({ type: 'head', label: 'View' });
    MENU.push({ type: 'act', label: 'Turn everything off except GMUs', act: function () { for (var k in LAY) { if (LAY.hasOwnProperty(k) && LAY[k].on && k !== 'gmu') { setLayer(k, false); } } if (!LAY.gmu.on) { setLayer('gmu', true); } } });
    MENU.push({ type: 'act', label: 'Show / hide legend', act: function () { toggleLegend(); } });
    MENU.push({ type: 'act', label: 'Reset view to all of Colorado', act: function () { homeView(); } });
    MENU.push({ type: 'act', label: 'Close menu', act: function () { closeMenu(); } });
  }
  function renderMenu() {
    if (!menuOpen) { return; }
    var h = '';
    for (var i = 0; i < MENU.length; i++) {
      var it = MENU[i];
      if (it.type === 'head') { h += '<div class="mhead">' + esc(it.label) + '</div>'; continue; }
      var on = false, note = '', sw = '';
      if (it.type === 'base') { on = prefs.base === it.i; }
      if (it.type === 'layer') {
        var E = LAY[it.key];
        on = E.on; sw = swatch(E.m);
        if (E.loading) { note = 'loading\u2026'; }
      }
      h += '<div class="mitem' + (i === menuSel ? ' sel' : '') + '" data-i="' + i + '">' +
        (it.type === 'act' ? '<span class="chk" style="border-color:transparent">&#8250;</span>' :
          '<span class="chk' + (on ? ' on' : '') + (it.type === 'base' ? ' radio' : '') + '">' + (on ? '&#10003;' : '') + '</span>') +
        sw + '<span class="mlabel">' + esc(it.label) + '</span>' + (note ? '<span class="mnote">' + note + '</span>' : '') + '</div>';
    }
    $('menulist').innerHTML = h;
    var sel = $('menulist').querySelector('.sel');
    if (sel && sel.scrollIntoView) { sel.scrollIntoView({ block: 'nearest' }); }
  }
  function touchMenu() { clearTimeout(menuIdle); menuIdle = setTimeout(closeMenu, MENU_IDLE_MS); }
  function openMenu() { menuOpen = true; $('menu').className = 'panel'; renderMenu(); touchMenu(); }
  function closeMenu() { menuOpen = false; clearTimeout(menuIdle); $('menu').className = 'panel hidden'; }
  function menuMove(d) {
    var i = menuSel;
    do { i = (i + d + MENU.length) % MENU.length; } while (MENU[i].type === 'head');
    menuSel = i; renderMenu(); touchMenu();
  }
  function menuActivate(i) {
    var it = MENU[i];
    if (!it || it.type === 'head') { return; }
    menuSel = i;
    if (it.type === 'base') { setBase(it.i); }
    else if (it.type === 'layer') { setLayer(it.key, !LAY[it.key].on); }
    else if (it.type === 'act') { it.act(); }
    renderMenu(); touchMenu();
  }
  $('menulist').onclick = function (e) {
    var t = e.target;
    while (t && t !== this && !t.getAttribute('data-i')) { t = t.parentNode; }
    if (t && t.getAttribute && t.getAttribute('data-i')) { menuActivate(parseInt(t.getAttribute('data-i'), 10)); }
  };
  $('layersbtn').onclick = function () { if (menuOpen) { closeMenu(); } else { openMenu(); } };

  // ---------- Legend, header, toast ----------
  function renderLegend() {
    var el = $('legend');
    if (!prefs.legend) { el.className = 'panel hidden'; return; }
    var arr = [], k, h = '';
    for (k in LAY) { if (LAY.hasOwnProperty(k) && LAY[k].on) { arr.push(LAY[k].m); } }
    arr.sort(function (a, b) { return b.z - a.z; });
    var rows = 0;
    for (var i = 0; i < arr.length && rows < 16; i++) {
      var m = arr[i];
      if (m.classes && m.key !== 'research') {
        h += '<div class="lghead">' + esc(m.label) + '</div>';
        for (var c in m.classes) {
          if (!m.classes.hasOwnProperty(c) || rows >= 16) { continue; }
          h += '<div class="lgrow"><span class="sw" style="background:' + m.classes[c].fillColor + ';opacity:0.8"></span>' + esc(m.classes[c].label) + '</div>';
          rows++;
        }
      } else {
        h += '<div class="lgrow">' + swatch(m) + esc(m.lg || m.label) + '</div>';
        rows++;
      }
    }
    el.innerHTML = h || '<div class="lgrow">No layers on</div>';
    el.className = 'panel';
  }
  function toggleLegend() { prefs.legend = !prefs.legend; savePrefs(); renderLegend(); }
  function setStatus(s) { $('status').innerHTML = esc(s || ''); if (!s) { renderLayerLine(); } }
  function renderLayerLine() {
    var n = 0, k, loading = false;
    for (k in LAY) { if (LAY.hasOwnProperty(k)) { if (LAY[k].on) { n++; } if (LAY[k].loading) { loading = true; } } }
    if (!loading) { $('status').innerHTML = esc(n + ' layer' + (n === 1 ? '' : 's') + ' on \u00b7 ' + BASEMAPS[prefs.base].name); }
  }
  var toastTimer = null;
  function toast(s, ms) {
    var el = $('toast');
    el.innerHTML = esc(s);
    el.className = 'panel';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'panel hidden'; }, ms || 3200);
  }
  var helpTimer = null;
  function wakeHelp() {
    var h = $('help');
    h.className = 'panel';
    clearTimeout(helpTimer);
    helpTimer = setTimeout(function () { h.className = 'panel faded'; }, HELP_FADE_MS);
  }

  // ---------- Go to a GMU by number ----------
  var digits = '', digitTimer = null;
  function digit(d) {
    digits = (digits + d).slice(-3);
    toast('Go to GMU ' + digits + '\u2026', 1700);
    clearTimeout(digitTimer);
    digitTimer = setTimeout(goGmu, 1500);
  }
  function goGmu() {
    var n = parseInt(digits, 10), f = null;
    digits = '';
    if (!store.gmu) { return; }
    for (var i = 0; i < store.gmu.features.length; i++) { if (store.gmu.features[i].properties.n === n) { f = store.gmu.features[i]; break; } }
    if (!f) { toast('There is no GMU ' + n); return; }
    if (!LAY.gmu.on) { setLayer('gmu', true); }
    closeMenu();
    map.fitBounds([[f.bb[1], f.bb[0]], [f.bb[3], f.bb[2]]], { paddingTopLeft: [60, 120], paddingBottomRight: [860, 120], maxZoom: 11, animate: false });
    identify(L.latLng(f.properties.lp[0], f.properties.lp[1]));
  }

  // ---------- Pointer vs. arrow keys ----------
  var cursorVisible = false, lastClick = 0;
  function setCursor(v) {
    cursorVisible = v;
    $('cross').className = v ? 'hidden' : '';
  }
  document.addEventListener('cursorStateChange', function (e) {
    if (e && e.detail && typeof e.detail.visibility === 'boolean') { setCursor(e.detail.visibility); }
  }, false);
  document.addEventListener('mousemove', function () { if (!cursorVisible) { setCursor(true); } }, false);
  map.on('click', function (e) {
    lastClick = Date.now();
    if (menuOpen) { closeMenu(); return; }
    identify(e.latlng);
  });

  // ---------- Remote control ----------
  function goBack() {
    if (menuOpen) { closeMenu(); return true; }
    if (popOpen) { closePop(); return true; }
    return false;
  }
  var okTimer = null, okPending = false, okHeld = false;
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode, handled = true;
    wakeHelp();
    if (k === 37 || k === 38 || k === 39 || k === 40) { setCursor(false); }
    if (k >= 48 && k <= 57) { digit(k - 48); if (e.preventDefault) { e.preventDefault(); } return; }
    if (menuOpen) {
      touchMenu();
      if (k === 38) { menuMove(-1); }
      else if (k === 40) { menuMove(1); }
      else if (k === 37 || k === 39) { menuActivate(menuSel); }
      else if (k === 13) { if (!okHeld && !e.repeat) { menuActivate(menuSel); } }
      else if (k === 461 || k === 27 || k === 403) { closeMenu(); }
      else if (k === 404) { setBase(prefs.base + 1); }
      else if (k === 405) { toggleLegend(); }
      if (e.preventDefault) { e.preventDefault(); }
      return;
    }
    if (popOpen && (k === 37 || k === 38 || k === 39 || k === 40)) {
      if (k === 38) { scrollPop(-1); } else if (k === 40) { scrollPop(1); }
      else if (k === 37) { showHit(popSel - 1); } else if (k === 39) { showHit(popSel + 1); }
      if (e.preventDefault) { e.preventDefault(); }
      return;
    }
    switch (k) {
      case 37: map.panBy([-PAN_PX, 0]); break;
      case 38: map.panBy([0, -PAN_PX]); break;
      case 39: map.panBy([PAN_PX, 0]); break;
      case 40: map.panBy([0, PAN_PX]); break;
      case 13:
        if (!okPending && !e.repeat) {
          okPending = true;
          okTimer = setTimeout(function () { okPending = false; okHeld = true; openMenu(); }, HOLD_MS);
        }
        break;
      case 403: openMenu(); break;                       // red
      case 404: setBase(prefs.base + 1); toast(BASEMAPS[prefs.base].name, 1800); break;  // green
      case 405: toggleLegend(); break;                   // yellow
      case 406: closePop(); homeView(); break;           // blue
      case 33: case 187: case 107: case 61: map.zoomIn(0.5); break;
      case 34: case 189: case 109: case 173: map.zoomOut(0.5); break;
      case 461: case 27: handled = goBack(); break;
      default: handled = false;
    }
    if (handled && e.preventDefault) { e.preventDefault(); }
  }, false);
  document.addEventListener('keyup', function (e) {
    if (e.keyCode !== 13) { return; }
    if (okHeld) { okHeld = false; return; }
    if (okPending) {
      clearTimeout(okTimer);
      okPending = false;
      if (menuOpen || popOpen) { return; }
      if (cursorVisible || Date.now() - lastClick < 700) { return; }   // the pointer's own click already opened it
      identify(map.getCenter());
    }
  }, false);

  // ---------- Start ----------
  function start() {
    LIST = window.HMAP.layers || [];
    for (var i = 0; i < LIST.length; i++) { LAY[LIST[i].key] = { m: LIST[i], on: false, index: null, sty: null, loading: false }; }
    buildMenu();
    $('version').innerHTML = 'v' + VERSION + (window.HMAP.built ? ' \u00b7 data ' + esc(window.HMAP.built.slice(0, 10)) : '');
    setBase(prefs.base || 0);
    homeView();
    var keys = [];
    for (var j = 0; j < LIST.length; j++) {
      var want = prefs.on && prefs.on.hasOwnProperty(LIST[j].key) ? prefs.on[LIST[j].key] : LIST[j].on;
      if (want) { keys.push(LIST[j].key); }
    }
    keys.sort(function (a, b) { return LAY[a].m.z - LAY[b].m.z; });
    for (var n = 0; n < keys.length; n++) { setLayer(keys[n], true); }
    prefsReady = true;
    savePrefs();
    renderLegend();
    renderLayerLine();
    setCursor(false);
    wakeHelp();
  }
  loadScript('data/layers.js', function () { setStatus('Could not load the layer list'); });
  (function waitManifest(tries) {
    if (window.HMAP.layers) { start(); return; }
    if (tries > 200) { setStatus('Layer list did not load'); return; }
    setTimeout(function () { waitManifest(tries + 1); }, 50);
  })(0);

  // Debug hook for testing over the developer connection
  window.HAPP = {
    version: VERSION, map: map, LAY: LAY, store: store, pops: pops, errors: errors,
    identify: identify, setLayer: setLayer, openMenu: openMenu, closeMenu: closeMenu, closePop: closePop, goGmu: function (n) { digits = String(n); goGmu(); },
    state: function () {
      var on = [], k;
      for (k in LAY) { if (LAY.hasOwnProperty(k) && LAY[k].on) { on.push(k + (LAY[k].index ? '' : '(loading)')); } }
      return { on: on, zoom: map.getZoom(), center: map.getCenter(), popOpen: popOpen, hits: popHits.length, menuOpen: menuOpen, errors: errors.slice(-5) };
    }
  };
})();
