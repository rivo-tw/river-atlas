/* River Atlas — static front end. Data lives in data/index.json + data/flights/<id>/ */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = {
    get(k, d) { try { const v = localStorage.getItem("ra:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("ra:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const COLORS = {
    debris: "#ff5108", vegetation: "#6f8f00", habitat: "#0067a5",
    plastic_bottle: "#ff5108", plastice_bag: "#e8730c", unknown_floating_debris: "#d14b00",
    underwater_debris: "#a33b00", wood_branch: "#b8862b", natural_vegetation: "#6f8f00",
    fish: "#0067a5", fish_group: "#00385e",
  };
  const LAYERS = [
    { id: "water", state: "ready", sw: "#0090e0" },
    { id: "baseline", state: "planned" },
    { id: "color", state: "ready", sw: "#ff5108" },
    { id: "debris", state: "ready", sw: "#ff5108" },
    { id: "veg", state: "prelim", sw: "#6f8f00" },
    { id: "habitat", state: "prelim", sw: "#00385e" },
    { id: "change", state: "planned" },
  ];
  const GROUP_LAYER = { debris: "debris", vegetation: "veg", habitat: "habitat" };

  const S = {
    lang: store.get("lang", "zh"), fs: store.get("fs", 1), bin: store.get("bin", 50),
    theme: "water_w", base: "emap",
    on: { water: true, color: true, debris: true, veg: true, habitat: true },
    index: null, flight: null, data: null, sel: null,
  };
  const t = () => T[S.lang];

  /* ---------------------------------------------------------------- i18n */
  const zhCache = new Map();
  function applyLang() {
    document.documentElement.lang = S.lang === "zh" ? "zh-Hant-TW" : "en";
    $$("[data-i18n]").forEach((el) => {
      if (!zhCache.has(el)) zhCache.set(el, el.innerHTML);
      const key = el.dataset.i18n;
      el.innerHTML = S.lang === "en" && I18N_EN[key] != null ? I18N_EN[key] : zhCache.get(el);
    });
    $$(".langs button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.lang === S.lang)));
    if (S.index) $("#placeLine").textContent = S.lang === "zh" ? S.index.site.place_zh : S.index.site.place_en;
    document.title = S.lang === "zh" ? "河川環境圖譜｜「河」你一起，讀懂這條河" : "River Atlas | Reading the River, Together";
  }

  /* ---------------------------------------------------------------- font size */
  function applyFs() {
    document.documentElement.style.setProperty("--fs", S.fs);
    if (map) setTimeout(() => map.invalidateSize(), 50);
    if (strip.ready) strip.layout();
  }
  S.fs = 1;   // 字級 control removed; text size follows the window only
  $$(".langs button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.lang === S.lang) return;
    S.lang = b.dataset.lang; store.set("lang", S.lang); applyLang(); renderAll(); requestAnimationFrame(placeNavInd);
  }));

  /* ---------------------------------------------------------------- top bar: scroll edge + nav indicator */
  new IntersectionObserver(([en]) => $(".topbar").classList.toggle("scrolled", !en.isIntersecting))
    .observe($(".scroll-sentinel"));
  function placeNavInd() {
    const nav = $("#nav"), ind = $(".nav-ind"), cur = $('#nav a[aria-current="true"]');
    if (!cur) { ind.style.setProperty("--o", 0); return; }
    ind.style.setProperty("--x", cur.offsetLeft + "px");
    ind.style.setProperty("--s", cur.offsetWidth / 100);
    ind.style.setProperty("--o", 1);
    // phones: keep the current item visible in the scrolling nav row
    if (nav.scrollWidth > nav.clientWidth) {
      const left = cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2;
      nav.scrollTo({ left, behavior: reduceMotion ? "auto" : "smooth" });
    }
  }
  addEventListener("resize", () => placeNavInd());

  /* ---------------------------------------------------------------- springs + bottom sheets (phones) */
  const phone = matchMedia("(max-width: 760px)");
  const project = (v, d = 0.998) => (v / 1000) * d / (1 - d);
  // spring on one value; starts from the live value, carries the given velocity
  function spring(st, target, v0, { response = 0.35, damping = 1, apply, done } = {}) {
    cancelAnimationFrame(st.raf);
    if (reduceMotion) { st.y = target; apply(target); done && done(); return; }
    const w = (2 * Math.PI) / response; let v = v0, last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.032, (now - last) / 1000); last = now;
      v += (-w * w * (st.y - target) - 2 * damping * w * v) * dt;
      st.y += v * dt;
      if (Math.abs(st.y - target) < 0.5 && Math.abs(v) < 5) { st.y = target; apply(target); done && done(); return; }
      apply(st.y); st.raf = requestAnimationFrame(step);
    };
    st.raf = requestAnimationFrame(step);
  }
  const rubber = (o, dim, c = 0.55) => (o * dim * c) / (dim + c * Math.abs(o));
  function sheetDrag(handle, st, { bounds, onMove, onRelease }) {
    let id = null, y0 = 0, start = 0, hist = [];
    handle.addEventListener("pointerdown", (e) => {
      if (!phone.matches || e.button > 0) return;
      cancelAnimationFrame(st.raf);                      // grab mid-flight
      id = e.pointerId; y0 = e.clientY; start = st.y; hist = [[e.timeStamp, st.y]]; st.moved = false;
    });
    handle.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return;
      const dy = e.clientY - y0;
      if (!st.moved && Math.abs(dy) < 8) return;
      if (!st.moved) { st.moved = true; handle.setPointerCapture(id); }
      const [lo, hi] = bounds(), raw = start + dy;
      const y = raw < lo ? lo - rubber(lo - raw, 400) : raw > hi ? hi + rubber(raw - hi, 400) : raw;
      st.y = y; onMove(y);
      hist.push([e.timeStamp, raw]); if (hist.length > 6) hist.shift();
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      if (!st.moved) return;
      const a = hist[0], b = hist[hist.length - 1];
      const v = b[0] > a[0] ? ((b[1] - a[1]) / (b[0] - a[0])) * 1000 : 0;
      onRelease(st.y, v);
      setTimeout(() => { st.moved = false; }, 0);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  // layer panel: open (0) or tucked down to its handle
  const lp = $("#layerPanel"), lst = { y: 0, raf: 0 };
  const lpClosed = () => Math.max(0, lp.offsetHeight - 52);
  const lpApply = (y) => { lp.style.transform = phone.matches ? `translate3d(0,${y}px,0)` : ""; };
  const lpSet = (open, v = 0) => {
    $("#layerGrab").setAttribute("aria-expanded", String(open));
    spring(lst, open ? 0 : lpClosed(), v, { response: 0.32, damping: Math.abs(v) > 300 ? 0.85 : 1, apply: lpApply });
  };
  sheetDrag($("#layerGrab"), lst, {
    bounds: () => [0, lpClosed()], onMove: lpApply,
    onRelease: (y, v) => { const p = y + project(v); lpSet(p < lpClosed() / 2, v); },
  });
  $("#layerGrab").addEventListener("click", () => {
    if (lst.moved) return;
    lpSet($("#layerGrab").getAttribute("aria-expanded") !== "true");
  });
  const lpInit = () => {
    if (phone.matches) { lst.y = lpClosed(); lpApply(lst.y); $("#layerGrab").setAttribute("aria-expanded", "false"); }
    else { lst.y = 0; lpApply(0); $("#layerGrab").setAttribute("aria-expanded", "true"); }
  };
  phone.addEventListener("change", lpInit);

  /* ---------------------------------------------------------------- segmented controls */
  function segInit(el, onPick) {
    const thumb = $(".seg-thumb", el) || el.appendChild(Object.assign(document.createElement("span"), { className: "seg-thumb" }));
    const place = () => {
      const on = $('button[aria-checked="true"]', el);
      if (!on) return;
      thumb.style.width = on.offsetWidth + "px";
      thumb.style.transform = `translateX(${on.offsetLeft}px)`;
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !el.contains(b)) return;
      $$("button", el).forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      place(); onPick(b);
    });
    el.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const bs = $$("button", el), i = bs.findIndex((x) => x.getAttribute("aria-checked") === "true");
      const n = bs[(i + (e.key === "ArrowRight" ? 1 : bs.length - 1)) % bs.length];
      n.focus(); n.click();
    });
    new ResizeObserver(place).observe(el);
    requestAnimationFrame(place);
    return place;
  }

  /* ---------------------------------------------------------------- map */
  let map, baseLayers, trackLine, secLayer, heatLayer, objLayer, droneMarker;
  function initMap() {
    const c = S.index.site.center;
    map = L.map("leaflet", { zoomControl: false, attributionControl: true, zoomSnap: 1, zoomDelta: 1, minZoom: 13, maxZoom: 19 })
      .setView(c, 17);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    const nlsc = (layer, ext) => L.tileLayer(`https://wmts.nlsc.gov.tw/wmts/${layer}/default/GoogleMapsCompatible/{z}/{y}/{x}`,
      { maxNativeZoom: 18, maxZoom: 19, attribution: '&copy; <a href="https://maps.nlsc.gov.tw/" target="_blank" rel="noopener">國土測繪中心</a>' });
    baseLayers = { emap: nlsc("EMAP"), photo: nlsc("PHOTO2") };
    baseLayers.emap.addTo(map);
    map.attributionControl.setPrefix(false);
    map.on("click", (e) => {
      if (e.originalEvent.target.closest(".leaflet-interactive")) return;
      closeDetail();
    });
  }

  function ramp(theme) {
    if (theme === "color_sigma") return ["#0090e0", "#a6d8f5", "#f1f1ee", "#ffb08c", "#ff5108"];
    if (theme === "debris" || theme === "color_anom") return ["#fff1ea", "#ffc4a6", "#ff8a56", "#ff5108", "#b33600"];
    return ["#e3f2fc", "#a6d8f5", "#4fb3ea", "#0090e0", "#00609a"];
  }
  function colorFor(v, lo, hi, theme) {
    if (v == null) return "#9aa7b1";
    const r = ramp(theme), f = Math.max(0, Math.min(0.9999, (v - lo) / ((hi - lo) || 1)));
    return r[Math.floor(f * r.length)];
  }
  function themeRange(bins, theme) {
    const v = bins.map((b) => b[theme]).filter((x) => x != null);
    if (theme === "color_sigma") { const m = Math.max(2, ...v.map(Math.abs)); return [-m, m]; }
    if (theme === "debris") return [0, Math.max(3, ...v)];
    if (theme === "color_anom") return [0, Math.max(5, ...v)];
    return [Math.min(...v), Math.max(...v)];
  }

  function drawSections() {
    if (secLayer) secLayer.remove();
    const bins = S.data.bins[S.bin];
    const [lo, hi] = themeRange(bins, S.theme);
    secLayer = L.featureGroup();
    bins.forEach((b) => {
      const p = L.polygon(b.poly, {
        color: "#ffffff", weight: 1.5, opacity: 0.9, fillColor: colorFor(b[S.theme], lo, hi, S.theme),
        fillOpacity: S.on.water || S.theme !== "water_w" ? 0.5 : 0.08, className: "sec-poly",
      });
      p.binId = b.id;
      p.on("mouseover", () => p.setStyle({ weight: 3, color: "#00385e" }));
      p.on("mouseout", () => p.setStyle({ weight: S.sel?.type === "bin" && S.sel.id === b.id ? 3 : 1.5, color: S.sel?.type === "bin" && S.sel.id === b.id ? "#ff5108" : "#ffffff" }));
      p.on("click", () => openBin(b.id));
      p.bindTooltip(`${t().section(b.id)}　${b[S.theme] ?? t().na}`, { sticky: true, direction: "top", opacity: 0.95 });
      secLayer.addLayer(p);
    });
    secLayer.addTo(map);
    if (trackLine) trackLine.bringToFront();
    if (objLayer) objLayer.eachLayer((m) => m.setZIndexOffset(500));
    drawLegend(lo, hi);
  }

  function drawLegend(lo, hi) {
    const r = ramp(S.theme), unit = { water_w: " m", color_sigma: " σ", color_anom: "%", debris: "" }[S.theme];
    const fmt = (v) => (Math.round(v * 10) / 10) + unit;
    $("#legend").innerHTML = `
      <div><b>${t().themes[S.theme]}</b></div>
      <div class="ramp" style="background:linear-gradient(90deg,${r.join(",")})"></div>
      <div class="ends"><span>${fmt(lo)}</span><span>${fmt(hi)}</span></div>
      ${!S.on.color ? "" : S.data.heat.length ? `<div style="margin-top:10px">${t().heatLegend(S.data.flight.warn_thr)}</div>
      <div class="ramp" style="background:linear-gradient(90deg,rgba(255,200,0,.2),#ffb000,#ff5108,#c00000)"></div>`
        : `<div style="margin-top:10px">${t().layers.color[0]}：${t().noWarn(S.data.flight.warn_thr)}</div>`}`;
  }

  function drawStatic() {
    const d = S.data;
    [trackLine, heatLayer, objLayer, droneMarker].forEach((l) => l && l.remove());
    trackLine = L.polyline(d.track.map((p) => [p[0], p[1]]), { color: "#00385e", weight: 3, opacity: 0.85, dashArray: "1 7", lineCap: "round" }).addTo(map);
    trackLine.on("click", (e) => {
      let best = 0, bd = Infinity;
      d.track.forEach((p, i) => { const q = (p[0] - e.latlng.lat) ** 2 + (p[1] - e.latlng.lng) ** 2; if (q < bd) { bd = q; best = i; } });
      strip.goTo(d.track[best][2]);
    });
    heatLayer = L.heatLayer(d.heat, { radius: 13, blur: 17, max: 1.4, maxZoom: 18, minOpacity: 0.1,
      gradient: { 0.2: "rgba(255,200,0,.6)", 0.5: "#ffb000", 0.75: "#ff5108", 1: "#c00000" } });
    objLayer = L.layerGroup();
    d.objects.forEach((o) => {
      const m = L.marker([o.lat, o.lon], {
        icon: L.divIcon({ className: "", html: `<div class="obj-dot" style="background:${COLORS[o.cls]}"></div>`, iconSize: [14, 14] }),
        keyboard: true, title: label(o.cls), riseOnHover: true,
      });
      m.obj = o;
      m.on("click", () => lightbox.open(o.id, m.getElement()));
      objLayer.addLayer(m);
    });
    droneMarker = L.marker(d.track[0].slice(0, 2), { icon: L.divIcon({ className: "", html: '<div class="drone-dot"></div>', iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
    map.fitBounds(trackLine.getBounds(), { paddingTopLeft: innerWidth > 760 ? [300, 70] : [20, 60], paddingBottomRight: innerWidth > 760 ? [20, 20] : [20, 200] });
    applyLayers();
  }

  function applyLayers() {
    if (!S.data) return;
    if (S.on.color) heatLayer.addTo(map); else heatLayer.remove();
    objLayer.eachLayer((m) => {
      const vis = S.on[GROUP_LAYER[m.obj.group]];
      if (vis && !map.hasLayer(m)) m.addTo(map);
      if (!vis && map.hasLayer(m)) m.remove();
    });
    drawSections();
    strip.syncObjects();
  }

  const label = (cls) => S.data.flight.classes[cls]?.[S.lang === "zh" ? "zh" : "en"] || cls;

  /* ---------------------------------------------------------------- layer panel */
  function renderLayerPanel() {
    $("#layerCount").textContent = `${LAYERS.filter((l) => l.state !== "planned").length} / 7`;
    $("#layerList").innerHTML = LAYERS.map((l) => {
      const [name, sub] = t().layers[l.id];
      const tag = { ready: ["on", t().ready], prelim: ["pre", t().prelim], planned: ["plan", t().planned] }[l.state];
      const can = l.state !== "planned";
      return `<li class="layer ${can ? "" : "is-plan"}">
        <input type="checkbox" id="ly-${l.id}" ${can && S.on[l.id] ? "checked" : ""} ${can ? "" : "disabled"}>
        <label for="ly-${l.id}">${l.sw ? `<span class="sw" style="background:${l.sw}"></span>` : ""}${name}<small>${sub}</small></label>
        <span class="tag ${tag[0]}">${tag[1]}</span></li>`;
    }).join("");
    $$("#layerList input").forEach((i) => i.addEventListener("change", () => {
      S.on[i.id.slice(3)] = i.checked; applyLayers();
    }));
    // sigma compares a section with its own earlier flights: only offered once it exists
    const hasSigma = S.data.bins[S.bin].some((b) => b.color_sigma != null);
    if (!hasSigma && S.theme === "color_sigma") S.theme = "water_w";
    // one flight: water colour is not compared between sections, so it is not a colouring option
    if (!hasSigma && S.theme === "color_anom") S.theme = "water_w";
    const themes = hasSigma ? ["water_w", "color_sigma", "debris"] : ["water_w", "debris"];
    $("#themeSeg").innerHTML = themes.map((k) => `<button type="button" role="radio" data-theme="${k}" aria-checked="${k === S.theme}">${t().themes[k]}</button>`).join("");
    themePlace = segInit($("#themeSeg"), (b) => { S.theme = b.dataset.theme; drawSections(); });
  }
  let themePlace;


  /* ---------------------------------------------------------------- detail panel */
  const fmt = (v, d = 1) => (v == null ? t().na : (+v).toFixed(d));
  function openBin(id) {
    const b = S.data.bins[S.bin].find((x) => x.id === id);
    S.sel = { type: "bin", id };
    const tt = t();
    $("#detailBody").innerHTML = `
      <h3>${tt.section(b.id)}</h3>
      <p class="sub">${tt.range(b.s0, b.s1)}　${b.lat.toFixed(5)}, ${b.lon.toFixed(5)}</p>
      <img src="${S.flight.path}${b.shot}" alt="" loading="lazy">
      <dl class="kv">
        <dt>${tt.water_w}</dt><dd>${fmt(b.water_w)} m</dd>
        <dt>${tt.chan_w}</dt><dd>${fmt(b.chan_w)} m</dd>
        <dt>${tt.water_share}</dt><dd>${fmt(b.water_share, 0)}%</dd>
        <dt>${tt.color_anom}</dt><dd>${fmt(b.color_anom)}%</dd>
        <dt>${tt.color_sigma}</dt><dd>${b.color_sigma == null ? tt.sigmaPending : `${b.color_sigma > 0 ? "+" : ""}${fmt(b.color_sigma)} σ`}</dd>
        <dt>${tt.color_warn(S.data.flight.warn_thr)}</dt><dd>${b.color_warn} ${tt.frames}</dd>
        <dt>${tt.debris}</dt><dd>${b.debris} ${tt.items}</dd>
        <dt>${tt.vegetation}</dt><dd>${b.vegetation} ${tt.spots}</dd>
        <dt>${tt.fish}</dt><dd>${b.fish} ${tt.spots}</dd>
        <dt>${tt.fish_group}</dt><dd>${b.fish_group} ${tt.spots}</dd>
        <dt>${tt.framesIn}</dt><dd>${b.frames} ${tt.frames}</dd>
      </dl>
      ${Object.keys(b.by_cls).length ? `<div class="chips">${Object.entries(b.by_cls).map(([k, v]) => `<span>${label(k)} ${v}</span>`).join("")}</div>` : ""}
      ${(() => {
        const objs = S.data.objects.filter((o) => o.s >= b.s0 && o.s < b.s1 && S.on[GROUP_LAYER[o.group]]);
        return objs.length ? `<p class="panel-label">${tt.objsHere}</p><div class="obj-strip">${objs.map((o) =>
          `<button type="button" class="zoomable" data-obj="${o.id}" title="${label(o.cls)}"><img src="${S.flight.path}${o.thumb}" alt="${label(o.cls)}" loading="lazy"></button>`).join("")}</div>` : "";
      })()}
      <button type="button" class="btn" data-go="${(b.s0 + b.s1) / 2}">${tt.seeStrip}</button>`;
    showDetail();
    highlightBin(id);
  }
  function openObj(id) {
    const o = S.data.objects.find((x) => x.id === id);
    S.sel = { type: "obj", id };
    const tt = t();
    $("#detailBody").innerHTML = `
      <h3>${label(o.cls)}</h3>
      <p class="sub">${o.lat.toFixed(6)}, ${o.lon.toFixed(6)}</p>
      <button type="button" class="zoomable" data-obj="${o.id}" style="width:160px"><img class="sq" src="${S.flight.path}${o.thumb}" alt="${label(o.cls)}" loading="lazy"><span class="hint">${tt.zoomHint}</span></button>
      <dl class="kv">
        <dt>${tt.position}</dt><dd>${o.s.toFixed(0)} m</dd>
        <dt>${tt.conf}</dt><dd>${o.conf.toFixed(2)}</dd>
        <dt>${tt.seen}</dt><dd>${o.frames} ${tt.frames}</dd>
        <dt>${tt.time}</dt><dd>${o.t.toFixed(1)} s</dd>
      </dl>
      <button type="button" class="btn" data-go="${o.s}">${tt.seeOnStrip}</button>`;
    showDetail();
    highlightBin(null);
  }
  const dst = { y: 0, raf: 0 };
  function showDetail() {
    const d = $("#detail");
    cancelAnimationFrame(dst.raf); dst.y = 0; d.style.transform = "";
    d.classList.remove("leaving");
    d.hidden = false; d.style.animation = "none"; void d.offsetWidth; d.style.animation = "";
    $$("[data-obj]", d).forEach((z) => z.addEventListener("click", () => lightbox.open(z.dataset.obj, z)));
    const go = $("[data-go]", d);
    if (go) go.addEventListener("click", () => { $("#strip").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" }); strip.goTo(+go.dataset.go); });
  }
  // leaves along the path it came in on (CSS keyframes mirror the entrance)
  function closeDetail() {
    const d = $("#detail");
    S.sel = null; highlightBin(null);
    if (d.hidden) return;
    d.classList.add("leaving");
    d.addEventListener("animationend", function done() {
      d.removeEventListener("animationend", done);
      if (d.classList.contains("leaving")) { d.hidden = true; d.classList.remove("leaving"); d.style.transform = ""; }
    });
  }
  // phones: drag the sheet down to dismiss, flick to throw it away
  sheetDrag($("#detail .sheet-grab"), dst, {
    bounds: () => [0, $("#detail").offsetHeight],
    onMove: (y) => { $("#detail").style.transform = `translate3d(0,${y}px,0)`; },
    onRelease: (y, v) => {
      const d = $("#detail"), h = d.offsetHeight, away = y + project(v) > h * 0.45;
      spring(dst, away ? h + 20 : 0, v, {
        response: 0.3, damping: away ? 1 : 0.85,
        apply: (yy) => { d.style.transform = `translate3d(0,${yy}px,0)`; },
        done: () => { if (away) { d.hidden = true; d.style.transform = ""; dst.y = 0; S.sel = null; highlightBin(null); } },
      });
    },
  });
  $("#detailClose").addEventListener("click", closeDetail);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#detail").hidden) closeDetail(); });

  function highlightBin(id) {
    if (secLayer) secLayer.eachLayer((p) => p.setStyle(p.binId === id ? { weight: 3, color: "#ff5108" } : { weight: 1.5, color: "#ffffff" }));
    $$("#secTable tbody tr").forEach((r) => r.setAttribute("aria-selected", String(+r.dataset.id === id)));
  }

  /* ---------------------------------------------------------------- object lightbox
     Opens out of the dot / thumbnail that was tapped and returns into it on close
     (same path both ways). Phones: swipe the image down to dismiss. */
  const lightbox = {
    dlg: $("#lightbox"), img: $("#lbImg"), view: "zoom", idx: -1, src: null, st: { y: 0, raf: 0 },
    list() { return S.data.objects.filter((o) => S.on[GROUP_LAYER[o.group]]); },
    render() {
      const L = this.list(), o = L[this.idx], tt = t();
      if (!o) return;
      $("#lbTitle").textContent = label(o.cls);
      $("#lbCount").textContent = tt.lbOf(this.idx + 1, L.length);
      this.img.src = S.flight.path + (this.view === "ctx" ? o.ctx : o.zoom || o.thumb);
      this.img.alt = label(o.cls);
      $("#lbFigure").classList.toggle("is-ctx", this.view === "ctx");
      $("#lbKv").innerHTML = `
        <dt>${tt.position}</dt><dd>${o.s.toFixed(0)} m</dd>
        <dt>${tt.conf}</dt><dd>${o.conf.toFixed(2)}</dd>
        <dt>${tt.seen}</dt><dd>${o.frames} ${tt.frames}</dd>
        <dt>${tt.time}</dt><dd>${o.t.toFixed(1)} s</dd>
        <dt>GPS</dt><dd>${o.lat.toFixed(5)}, ${o.lon.toFixed(5)}</dd>`;
      $("#lbPrev").disabled = this.idx <= 0;
      $("#lbNext").disabled = this.idx >= L.length - 1;
    },
    open(id, srcEl) {
      const L = this.list();
      this.idx = Math.max(0, L.findIndex((o) => o.id === id));
      this.src = srcEl || null;
      this.render();
      cancelAnimationFrame(this.st.raf); this.st.y = 0; this.dlg.style.transform = "";
      if (!this.dlg.open) this.dlg.showModal();
      lbPlace();
      this.flight(true);
    },
    // zoom between the source element and the image (FLIP on transform + opacity)
    flight(opening) {
      const src = this.src;
      const done = () => { if (!opening) { this.dlg.close(); this.dlg.style.opacity = ""; } };
      if (reduceMotion || !src || !src.isConnected) {
        this.dlg.animate([{ opacity: opening ? 0 : 1 }, { opacity: opening ? 1 : 0 }], { duration: 180, easing: "ease-out" }).onfinish = done;
        return;
      }
      const a = src.getBoundingClientRect(), b = this.img.getBoundingClientRect();
      const onScreen = a.bottom > 0 && a.top < innerHeight && a.width > 0;
      if (!onScreen || !b.width) { this.dlg.animate([{ opacity: opening ? 0 : 1 }, { opacity: opening ? 1 : 0 }], { duration: 180 }).onfinish = done; return; }
      const sc = Math.max(a.width / b.width, a.height / b.height);
      const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top + a.height / 2 - (b.top + b.height / 2);
      const from = { transform: `translate(${dx}px,${dy}px) scale(${sc})`, borderRadius: "50%", opacity: 0.4 };
      const to = { transform: "none", borderRadius: "0", opacity: 1 };
      const opt = { duration: opening ? 340 : 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" };
      this.img.animate(opening ? [from, to] : [to, from], opt);
      const side = $(".lb-side", this.dlg), fr = $(".lb-figure", this.dlg);
      side.animate([{ opacity: opening ? 0 : 1 }, { opacity: opening ? 1 : 0 }], { duration: opening ? 260 : 160, easing: "ease-out" });
      fr.animate([{ backgroundColor: opening ? "rgba(14,26,34,0)" : "#0e1a22" }, { backgroundColor: opening ? "#0e1a22" : "rgba(14,26,34,0)" }], opt);
      this.dlg.animate([{ boxShadow: "none", backgroundColor: opening ? "transparent" : "" }, { backgroundColor: opening ? "" : "transparent" }], opt).onfinish = done;
    },
    close() { if (this.dlg.open) this.flight(false); },
    step(d) { const n = this.idx + d; if (n < 0 || n >= this.list().length) return; this.idx = n; this.src = null; this.render(); },
  };
  let lbPlace = () => {};
  $("#lbClose").addEventListener("click", () => lightbox.close());
  $("#lbPrev").addEventListener("click", () => lightbox.step(-1));
  $("#lbNext").addEventListener("click", () => lightbox.step(1));
  lightbox.dlg.addEventListener("cancel", (e) => { e.preventDefault(); lightbox.close(); });
  lightbox.dlg.addEventListener("click", (e) => { if (e.target === lightbox.dlg) lightbox.close(); });   // backdrop
  lightbox.dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); lightbox.step(1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); lightbox.step(-1); }
  });
  $("#lbMap").addEventListener("click", () => {
    const o = lightbox.list()[lightbox.idx]; lightbox.src = null; lightbox.close();
    $("#map").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    map.flyTo([o.lat, o.lon], 18, { duration: reduceMotion ? 0 : 0.8 });
    openObj(o.id);
  });
  $("#lbStrip").addEventListener("click", () => {
    const o = lightbox.list()[lightbox.idx]; lightbox.src = null; lightbox.close();
    $("#strip").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" }); strip.goTo(o.s);
  });
  // phones: swipe the picture down to dismiss
  sheetDrag($(".lb-grab"), lightbox.st, {
    bounds: () => [0, lightbox.dlg.offsetHeight],
    onMove: (y) => { lightbox.dlg.style.transform = `translate3d(0,${y}px,0)`; },
    onRelease: (y, v) => {
      const h = lightbox.dlg.offsetHeight, away = y + project(v) > h * 0.3;
      spring(lightbox.st, away ? h + 40 : 0, v, {
        response: 0.3, damping: away ? 1 : 0.85,
        apply: (yy) => { lightbox.dlg.style.transform = `translate3d(0,${yy}px,0)`; },
        done: () => { if (away) { lightbox.dlg.close(); lightbox.dlg.style.transform = ""; lightbox.st.y = 0; } },
      });
    },
  });

  /* ---------------------------------------------------------------- stats, table, facts */
  function renderStats() {
    const f = S.data.flight, tt = t();
    const fish = (f.objects.fish || 0) + (f.objects.fish_group || 0);
    const rows = [
      [tt.statDate, f.date, ""],
      [tt.statLength, f.length_m.toFixed(0), tt.m],
      [tt.statWater, f.water_w_median.toFixed(1), tt.m],
      [tt.statDebris, f.debris_total, tt.items],
      [tt.statFish, fish, tt.spots],
      [tt.statFrames, f.frames_analysed, tt.frames],
    ];
    $("#stats").innerHTML = rows.map(([k, v, u]) => `<div><dt>${k}</dt><dd>${v}${u ? `<small>${u}</small>` : ""}</dd></div>`).join("");
  }
  function renderTable() {
    const bins = S.data.bins[S.bin], tt = t();
    const maxW = Math.max(...bins.map((b) => b.water_w || 0));
    $("#secTable tbody").innerHTML = bins.map((b) => `
      <tr data-id="${b.id}" tabindex="0" aria-selected="false">
        <td><b>${tt.section(b.id)}</b>　<span class="mono">${tt.range(b.s0, b.s1)}</span></td>
        <td class="mono">${b.lat.toFixed(4)}, ${b.lon.toFixed(4)}</td>
        <td class="num"><span class="bar-in" style="width:${(b.water_w / maxW) * 48}px"></span>${fmt(b.water_w)}</td>
        <td class="num">${fmt(b.water_share, 0)}%</td>
        ${b.color_sigma == null ? `<td class="num pending">${tt.sigmaPending}</td>`
          : `<td class="num ${b.color_sigma >= 1.5 ? "hot" : ""}">${b.color_sigma > 0 ? "+" : ""}${fmt(b.color_sigma)}</td>`}
        <td class="num">${b.debris}</td>
        <td class="num">${b.vegetation}</td>
        <td class="num">${b.fish + b.fish_group}</td>
      </tr>`).join("");
    $$("#secTable tbody tr").forEach((r) => {
      const go = () => {
        const id = +r.dataset.id;
        $("#map").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
        secLayer.eachLayer((p) => { if (p.binId === id) map.flyToBounds(p.getBounds(), { maxZoom: 18, duration: reduceMotion ? 0 : 0.8, paddingTopLeft: innerWidth > 760 ? [300, 60] : [20, 60], paddingBottomRight: innerWidth > 760 ? [360, 20] : [20, 300] }); });
        openBin(id);
      };
      r.addEventListener("click", go);
      r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }
  function renderStatus() {
    const tt = t();
    $("#statusTable tbody").innerHTML = LAYERS.map((l) => {
      const tag = { ready: ["on", tt.ready], prelim: ["pre", tt.prelim], planned: ["plan", tt.planned] }[l.state];
      return `<tr><td>${tt.layers[l.id][0]}</td><td>${tt.how[l.id]}</td><td><span class="tag ${tag[0]}">${tag[1]}</span></td></tr>`;
    }).join("");
  }
  function renderFacts() {
    const f = S.data.flight, tt = t().facts;
    const rows = [
      [tt.date, f.date], [tt.time, f.start_local.replace(/\.\d+/, "")],
      [tt.alt, `${f.altitude_m} m`], [tt.gsd, `${f.gsd_cm} cm/px`], [tt.len, `${f.length_m} m`],
      [tt.dur, `${f.duration_s} s`], [tt.frames, `${f.frames_analysed}`],
    ];
    $("#facts").innerHTML = rows.map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`).join("");
  }
  function renderFlights() {
    $("#flights").innerHTML = S.index.flights.map((f) => {
      const ready = f.status === "ready";
      return `<button type="button" class="flight" role="tab" aria-selected="${S.flight && f.id === S.flight.id}" ${ready ? "" : "disabled"} data-id="${f.id}">
        ${t().flight(f.no)}${ready ? ` <span class="mono">${f.date.slice(5).replace("-", "/")}</span>` : `<span class="soon">${t().planned}</span>`}</button>`;
    }).join("");
  }

  function renderAll() {
    if (!S.data) return;
    renderFlights(); renderStats(); renderLayerPanel(); renderTable(); renderStatus(); renderFacts();
    drawSections(); strip.renderRuler();
    if (phone.matches && $("#layerGrab").getAttribute("aria-expanded") !== "true") { lst.y = lpClosed(); lpApply(lst.y); }
    if (S.sel) S.sel.type === "bin" ? openBin(S.sel.id) : openObj(S.sel.id);
  }

  /* ---------------------------------------------------------------- strip (drag, momentum, rubber band) */
  const strip = {
    ready: false, x: 0, v: 0, target: null, raf: 0, scale: 1,
    init(meta, base) {
      this.meta = meta; this.base = base;
      this.view = $("#stripView"); this.track = $("#stripTrack");
      this.track.innerHTML = meta.tiles.map((tl) =>
        `<img class="tile" src="${base}strip/${tl.img}" data-x0="${tl.x0}" data-w="${tl.x1 - tl.x0}" alt="" draggable="false" decoding="async">` +
        (tl.water ? `<img class="wtile" src="${base}strip/${tl.water}" data-x0="${tl.x0}" data-w="${tl.x1 - tl.x0}" alt="" draggable="false" decoding="async">` : "")).join("");
      this.objEls = S.data.objects.map((o) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "sobj"; b.style.background = COLORS[o.cls]; b.title = label(o.cls);
        b.addEventListener("click", (e) => { e.stopPropagation(); if (!this.moved) lightbox.open(o.id, b); });
        b.obj = o; this.track.appendChild(b); return b;
      });
      this.view.setAttribute("aria-valuemax", Math.round(meta.length_m));
      this.bind(); this.ready = true; this.layout();
      this.set(Math.min(this.maxX, this.view.clientWidth / 2 / this.scale));   // open with the strip filling the view
      new ResizeObserver(() => this.layout()).observe(this.view);
    },
    layout() {
      const m = this.meta, h = this.view.clientHeight;
      this.scale = h / m.height_px;
      this.track.style.width = m.width_px * this.scale + "px";
      $$("img", this.track).forEach((im) => { im.style.left = im.dataset.x0 * this.scale + "px"; im.style.width = im.dataset.w * this.scale + "px"; });
      this.objEls.forEach((b) => {
        const o = b.obj;
        b.style.left = (o.s / m.res_m) * this.scale + "px";
        b.style.top = ((m.half_m - o.d) / m.res_m) * this.scale + "px";
      });
      this.renderRuler(); this.set(this.x);
    },
    // strip pixel (unscaled) <-> metres along path
    get maxX() { return this.meta.width_px; },
    sOf(x) { return x * this.meta.res_m; },
    set(x) {
      this.x = x;
      const vw = this.view.clientWidth;
      this.track.style.transform = `translate3d(${vw / 2 - x * this.scale}px,0,0)`;
      const s = Math.max(0, Math.min(this.meta.length_m, this.sOf(x)));
      $("#stripPos").textContent = `${s.toFixed(0)} m`;
      this.view.setAttribute("aria-valuenow", Math.round(s));
      this.ruler && (this.ruler.style.transform = `translateX(${vw / 2 - x * this.scale}px)`);
      this.updateDrone(s);
    },
    updateDrone(s) {
      if (!droneMarker || this._pending) return;
      this._pending = true;
      requestAnimationFrame(() => {
        this._pending = false;
        const ax = this.meta.axis; let i = Math.min(ax.length - 2, Math.max(0, Math.floor(s / (ax[1][0] - ax[0][0]))));
        const f = (s - ax[i][0]) / ((ax[i + 1][0] - ax[i][0]) || 1);
        droneMarker.setLatLng([ax[i][1] + (ax[i + 1][1] - ax[i][1]) * f, ax[i][2] + (ax[i + 1][2] - ax[i][2]) * f]);
      });
    },
    renderRuler() {
      if (!this.ready) return;
      const host = $("#stripRuler"); host.innerHTML = "";
      const r = document.createElement("div"); r.style.position = "absolute"; r.style.inset = "0"; r.style.willChange = "transform";
      const k = this.scale / this.meta.res_m;      // px per metre
      S.data.bins[S.bin].forEach((b, i) => {
        if (i % 2) return;
        const d = document.createElement("div"); d.className = "sec"; d.style.left = b.s0 * k + "px"; d.style.width = (b.s1 - b.s0) * k + "px"; r.appendChild(d);
      });
      for (let m = 0; m <= this.meta.length_m; m += 50) {
        const d = document.createElement("div"); d.className = "tick"; d.style.left = m * k + "px"; d.textContent = m + " m"; r.appendChild(d);
      }
      host.appendChild(r); this.ruler = r;
      // the ruler lives inside .wrap; offset by the wrap's left edge so ticks line up with the strip
      const off = host.getBoundingClientRect().left - this.view.getBoundingClientRect().left;
      r.style.left = -off + "px";
      this.set(this.x);
    },
    syncObjects() {
      if (!this.ready) return;
      this.objEls.forEach((b) => { b.hidden = !S.on[GROUP_LAYER[b.obj.group]]; });
    },
    rubber(x) {
      const dim = this.view.clientWidth / this.scale, c = 0.55;
      if (x < 0) return -((-x) * dim * c) / (dim + c * -x);
      if (x > this.maxX) { const o = x - this.maxX; return this.maxX + (o * dim * c) / (dim + c * o); }
      return x;
    },
    // critically damped spring toward target, carrying velocity (px/s, unscaled)
    animate(target, v0 = 0, response = 0.45) {
      cancelAnimationFrame(this.raf);
      this.target = target; this.v = v0;
      if (reduceMotion) { this.set(target); return; }
      const w = (2 * Math.PI) / response; let last = performance.now();
      const step = (now) => {
        const dt = Math.min(0.032, (now - last) / 1000); last = now;
        const a = -w * w * (this.x - this.target) - 2 * w * this.v;
        this.v += a * dt; const nx = this.x + this.v * dt;
        if (Math.abs(nx - this.target) < 0.3 && Math.abs(this.v) < 2) { this.set(this.target); return; }
        this.set(nx); this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    },
    goTo(s) { this.animate(Math.max(0, Math.min(this.maxX, s / this.meta.res_m)), 0, 0.6); },
    bind() {
      const v = this.view; let id = null, startX = 0, startPos = 0, hist = [];
      v.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        cancelAnimationFrame(this.raf);              // grab mid-flight: start from the live position
        id = e.pointerId; startX = e.clientX; startPos = this.x; hist = [[e.timeStamp, this.x]]; this.moved = false;
      });
      v.addEventListener("pointermove", (e) => {
        if (e.pointerId !== id) return;
        const dx = e.clientX - startX;
        if (!this.moved && Math.abs(dx) < 6) return;
        if (!this.moved) { this.moved = true; v.setPointerCapture(id); }
        const raw = startPos - dx / this.scale;
        this.set(this.rubber(raw));
        hist.push([e.timeStamp, raw]); if (hist.length > 6) hist.shift();
      });
      const end = (e) => {
        if (e.pointerId !== id) return;
        id = null;
        if (!this.moved) return;
        const a = hist[0], b = hist[hist.length - 1];
        const vel = b && a && b[0] > a[0] ? ((b[1] - a[1]) / (b[0] - a[0])) * 1000 : 0;
        const d = 0.998, proj = this.x + (vel / 1000) * d / (1 - d);
        const target = Math.max(0, Math.min(this.maxX, proj));
        this.animate(target, vel, 0.55);
        setTimeout(() => { this.moved = false; }, 0);
      };
      v.addEventListener("pointerup", end);
      v.addEventListener("pointercancel", end);
      v.addEventListener("wheel", (e) => {
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        e.preventDefault(); cancelAnimationFrame(this.raf);
        this.set(Math.max(0, Math.min(this.maxX, this.x + e.deltaX / this.scale)));
      }, { passive: false });
      v.addEventListener("keydown", (e) => {
        const step = (e.shiftKey ? 50 : 10) / this.meta.res_m;
        const base = this.target ?? this.x;
        if (e.key === "ArrowRight") { e.preventDefault(); this.animate(Math.min(this.maxX, base + step), this.v); }
        if (e.key === "ArrowLeft") { e.preventDefault(); this.animate(Math.max(0, base - step), this.v); }
        if (e.key === "Home") { e.preventDefault(); this.animate(0, this.v); }
        if (e.key === "End") { e.preventDefault(); this.animate(this.maxX, this.v); }
      });
      $("#stripWater").addEventListener("change", (e) => v.classList.toggle("hide-water", !e.target.checked));
      $("#stripObjects").addEventListener("change", (e) => v.classList.toggle("hide-obj", !e.target.checked));
    },
  };

  /* ---------------------------------------------------------------- nav highlight */
  const navLinks = $$(".nav a");
  const io = new IntersectionObserver((es) => es.forEach((en) => {
    if (en.isIntersecting) { navLinks.forEach((a) => a.setAttribute("aria-current", String(a.getAttribute("href") === "#" + en.target.id))); placeNavInd(); }
  }), { rootMargin: "-45% 0px -50% 0px" });
  ["map", "strip", "sections", "video", "method", "about"].forEach((id) => io.observe(document.getElementById(id)));

  /* ---------------------------------------------------------------- boot */
  async function getJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }
  async function loadFlight(f) {
    const p = "data/" + f.path;
    const [flight, b20, b50, objects, heat, track, stripMeta] = await Promise.all(
      ["flight.json", "bins_20.json", "bins_50.json", "objects.json", "heat.json", "track.json", "strip/strip.json"].map((n) => getJSON(p + n)));
    S.flight = { ...f, path: p };
    S.data = { flight, bins: { 20: b20, 50: b50 }, objects, heat, track };
    drawStatic();
    if (!strip.ready) strip.init(stripMeta, p);
    renderAll();
  }

  async function boot() {
    applyFs(); applyLang();
    $$("#binSeg button").forEach((b) => b.setAttribute("aria-checked", String(+b.dataset.bin === S.bin)));
    lbPlace = segInit($("#lbView"), (b) => { lightbox.view = b.dataset.view; lightbox.render(); });
    segInit($("#binSeg"), (b) => { S.bin = +b.dataset.bin; store.set("bin", S.bin); closeDetail(); renderAll(); });
    segInit($("#baseSeg"), (b) => {
      S.base = b.dataset.base;
      Object.entries(baseLayers).forEach(([k, l]) => (k === S.base ? l.addTo(map).bringToBack() : l.remove()));
    });
    try {
      S.index = await getJSON("data/index.json");
      $("#updated").textContent = S.index.site.updated;
      applyLang(); initMap(); lpInit();
      await loadFlight(S.index.flights.find((f) => f.status === "ready"));
    } catch (err) {
      console.error(err);
      $("#stats").innerHTML = `<div><dt>Error</dt><dd style="font-size:1rem">${String(err.message || err)}</dd></div>`;
    }
  }
  boot();
})();
