// Everything shown comes from the network, so it is only ever set as text, never as HTML.
"use strict";

const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
// The pages may also be hosted elsewhere. Then the app on this computer is read over https, if
// it has a trusted certificate (web/trust.sh), else over http, which Safari never allows.
const HELPER = "http://localhost:8080";
let routes = LOCAL ? [""] : ["https://localhost:8443", "http://localhost:8080"];
const KEEP = 100, POINTS = 100;
const $ = (id) => document.getElementById(id);
const state = { reports: [], last: 0, total: 0, offset: 0, failures: 0, sample: false, source: null, seen: 0, helper: null };

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined && text !== null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function svg(tag, attrs, text) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  return e;
}

const two = (n) => String(n).padStart(2, "0");
function clock(t, date) {
  const d = new Date(t * 1000);
  const c = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return date ? `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${c}` : c;
}
const ms = (n) => (n === undefined ? "" : n < 10000 ? `${n} ms` : `${Math.round(n / 1000)} s`);

// --- status bar

// kind: "ok", "no", "warn" or "" ; no text hides the entry
function setState(id, text, kind) {
  const e = $(id), b = e.querySelector("b");
  e.hidden = !text;
  e.className = "state" + (kind ? " " + kind : "");
  if (b.textContent !== (text || "")) b.textContent = text || "";
}

function showStatus(d) {
  setState("s-live", "Live", "ok");
  setState("s-broker", d.broker ? "connected" : "not connected", d.broker ? "ok" : "no");
  const m = d.broker ? d.module : null;
  setState("s-module", m === "online" ? "online" : m === "offline" ? "offline" : d.broker ? "no message yet" : "", m === "online" ? "ok" : m === "offline" ? "no" : "");
  if (!d.broker) notice("The app on this computer is running, but it cannot reach the MQTT broker. It keeps trying.");
  else if (m === "offline") notice("The module is not connected to the broker. Check its power and Wi-Fi.");
  else notice("");
}

// Why the app on this computer cannot be read, as far as the browser tells.
const AGENT = navigator.userAgent;
const APPLE_MOBILE = /iPhone|iPad|iPod/.test(AGENT) || (/Macintosh/.test(AGENT) && navigator.maxTouchPoints > 1);
const MOBILE = APPLE_MOBILE || /Android/.test(AGENT);
const SAFARI = APPLE_MOBILE || (/Safari\//.test(AGENT) && !/Chrome\/|Chromium\/|CriOS\/|FxiOS\/|Edg\//.test(AGENT));

async function permission() {
  for (const name of ["loopback-network", "local-network-access"]) {
    try { return (await navigator.permissions.query({ name })).state; } catch { /* not known to this browser */ }
  }
  return "";
}

async function showUnreachable(waiting) {
  setState("s-broker"); setState("s-module");
  if (LOCAL) {
    setState("s-live", "App stopped", "no");
    notice("The app on this computer does not answer. Start it with web/run.sh." + (state.reports.length ? " The reports below are the last ones received." : ""), false, true);
    return;
  }
  setState("s-live", state.sample ? "Sample data" : "Not live", "warn");
  const what = state.sample ? "This is sample data." : "The app on this computer does not answer; the reports below are the last ones received.";
  if (MOBILE) return notice(what + " Live reports are shown only on the computer that runs the app.");
  if (SAFARI) return notice(what + " If the app is running on this computer, show its live data here through a small helper window, or open the live page directly.", true, true, true);
  if (waiting) return notice("Your browser is asking for permission to access the local network. Allow it to see live reports, or open the live page directly.", true);
  if ((await permission()) === "denied") return notice(what + " The browser blocks this site's access to the local network. Allow it in the site settings, or open the live page directly.", true, true);
  notice(state.sample ? what + " The app is not running on this computer, or the browser blocks access to it. Start it with web/run.sh, then try again or open the live page directly." : what + " Start it with web/run.sh; the page reconnects by itself.", true, true);
}

function showSince() {
  const r = state.reports[state.reports.length - 1];
  if (!r || state.sample) { $("since").textContent = ""; return; }
  const s = Math.max(0, Math.round(Date.now() / 1000 + state.offset - r.received));
  const ago = s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`;
  $("since").textContent = `Last report ${clock(r.received)}, ${ago} ago`;
}

// --- latest report

const EVENTS = { button: "Button pressed", command: "Simulated press", scale: "Printed by the scale" };

function flagsOf(d) {
  const f = [];
  if (d.error) return f;
  if (d.stable === true) f.push(["● Stable", "good"]);
  if (d.stable === false) f.push(["◌ Not stable", "warn"]);
  if (d.status === "Accept") f.push(["✓ Accept", "good"]);
  if (d.status === "Under") f.push(["▼ Under", "warn"]);
  if (d.status === "Over") f.push(["▲ Over", "bad"]);
  if (d.type === "N") f.push(["Net", "plain"]);
  return f;
}

function partsOf(d) {
  const p = [];
  const pair = (o) => (o.weight === undefined ? "" : `${o.weight} ${o.unit || ""}`.trim());
  if (d.mode) p.push(["Mode", d.mode]);
  if (d.gross) p.push(["Gross", pair(d.gross)]);
  if (d.net) p.push(["Net", pair(d.net)]);
  if (d.tare) p.push(["Tare", pair(d.tare) + (d.tare.preset ? " (preset)" : "")]);
  const names = { ref_wgt: "Reference", apw: "Piece weight", under: "Under limit", over: "Over limit", level: "Level", n: "Count", total: "Total", min: "Minimum", max: "Maximum" };
  const all = { ...d.info, ...d.accu };
  for (const k in names) if (all[k] !== undefined) p.push([names[k], String(all[k])]);
  if (d.text) p.push(["Text", d.text]);
  return p;
}

function remarks(r) {
  const d = r.data, out = [];
  if (d.error) out.push("Error: " + d.error);
  if (r.missing) out.push(r.missing === 1 ? "1 report lost before this one" : `${r.missing} reports lost before this one`);
  if (r.restarted) out.push("module restarted");
  if (d.late_ms !== undefined) out.push(`sent ${ms(d.late_ms)} late`);
  if (r.queued) out.push("arrived after a pause of the app, time may be later than the press");
  if (r.unchanged) out.push("same weight as before");
  if (d.text) out.push(d.text.replace(/\n/g, " / "));
  return out.join("; ");
}

function showLatest() {
  const r = state.reports[state.reports.length - 1];
  if (!r) return;
  const d = r.data, w = document.querySelector(".weight");
  w.classList.toggle("error", !!d.error);
  $("weight").textContent = d.error ? "No valid reading" : d.shown !== undefined ? d.shown : "-";
  $("unit").textContent = d.error ? "" : d.unit || "";
  $("flags").replaceChildren(...flagsOf(d).map(([t, c]) => el("span", t, c)));
  const bits = [EVENTS[d.event] || d.event, clock(r.received, true)];
  if (d.seq !== undefined) bits.push("No. " + d.seq);
  if (d.age_ms !== undefined) bits.push("reading " + ms(d.age_ms) + " old");
  if (d.error) bits.push(d.error);
  $("now-meta").textContent = bits.join(" · ");
  $("parts").replaceChildren(...partsOf(d).flatMap(([k, v]) => [el("dt", k), el("dd", v)]));
}

// --- table

function row(r) {
  const d = r.data, tr = el("tr");
  const st = [d.stable === true ? "stable" : d.stable === false ? "not stable" : "", d.status || "", d.type === "N" ? "net" : ""].filter(Boolean).join(", ");
  tr.append(el("td", clock(r.received, true)), el("td", d.seq), el("td", d.event), el("td", d.error ? "-" : d.shown, "n"), el("td", d.unit),
    el("td", st), el("td", d.mode), el("td", ms(d.age_ms), "n"), el("td", remarks(r), d.error ? "bad" : ""));
  return tr;
}

function addRows(list) {
  const body = $("rows");
  for (const r of list) body.prepend(row(r));
  while (body.rows.length > KEEP) body.deleteRow(-1);
  const bad = state.reports.filter((r) => r.data.error).length;
  $("count").textContent = `last ${state.reports.length}` + (bad ? `, ${bad} without a valid reading` : "");
}

// --- chart: one series, the weights in the unit of the newest reading

function niceTicks(lo, hi) {
  if (lo === hi) { const pad = Math.abs(lo) * 0.1 || 1; lo -= pad; hi += pad; }
  const raw = (hi - lo) / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw);
  const out = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step * 0.999; v += step) out.push(Number(v.toPrecision(12)));
  return { ticks: out, digits: Math.max(0, -Math.floor(Math.log10(step)) + (String(step / p) === "2.5" ? 1 : 0)) };
}

let hover = null;
function drawChart() {
  const box = $("plot"), all = state.reports.filter((r) => typeof r.data.weight === "number" && !r.data.error);
  const unit = all.length ? all[all.length - 1].data.unit || "" : "";
  const pts = all.filter((r) => (r.data.unit || "") === unit).slice(-POINTS);
  $("chart-title").textContent = unit ? `Weight in ${unit}, last ${pts.length} reports` : "Weight";
  if (!pts.length) { box.replaceChildren(el("p", "No weights yet", "empty")); return; }

  const W = Math.max(280, box.clientWidth), H = box.clientHeight, L = 54, R = 64, T = 14, B = 28;
  const ws = pts.map((r) => r.data.weight);
  const top = Math.max(...ws, 0), low = Math.min(0, ...ws);
  const { ticks, digits } = niceTicks(low > -top * 0.02 ? 0 : low, top); // a tiny negative reading needs no axis of its own
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const x = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1));
  const y = (v) => T + ((y1 - v) * (H - T - B)) / (y1 - y0);
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0", "aria-label": `Weight of the last ${pts.length} reports in ${unit || "the scale's unit"}. Newest: ${pts[pts.length - 1].data.shown}. The table below lists all values.` });
  for (const v of ticks) {
    s.append(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? "base" : "grid" }));
    s.append(svg("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end" }, v.toFixed(digits)));
  }
  s.append(svg("text", { x: x(0), y: H - 8, "text-anchor": pts.length === 1 ? "middle" : "start" }, clock(pts[0].received)));
  if (pts.length > 1) s.append(svg("text", { x: x(pts.length - 1), y: H - 8, "text-anchor": "end" }, clock(pts[pts.length - 1].received)));
  if (pts.length > 1) s.append(svg("path", { class: "path", d: pts.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(r.data.weight).toFixed(1)}`).join("") }));
  const few = pts.length <= 30;
  pts.forEach((r, i) => { if (few || i === pts.length - 1) s.append(svg("circle", { class: "dot", cx: x(i), cy: y(r.data.weight), r: 5 })); });
  const z = pts.length - 1;
  s.append(svg("text", { class: "last", x: x(z) + 10, y: y(ws[z]) + 4 }, pts[z].data.shown));

  const cross = svg("line", { class: "cross", y1: T, y2: H - B, visibility: "hidden" }), mark = svg("circle", { class: "dot", r: 6, visibility: "hidden" });
  s.append(cross, mark);
  const tip = el("div", null, "tip"); tip.hidden = true;
  const pick = (i) => {
    hover = i;
    const r = pts[i], on = { visibility: "visible" };
    for (const k in on) { cross.setAttribute(k, on[k]); mark.setAttribute(k, on[k]); }
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); mark.setAttribute("cx", x(i)); mark.setAttribute("cy", y(r.data.weight));
    tip.replaceChildren(el("b", `${r.data.shown} ${unit}`), el("span", `${clock(r.received, true)}${r.data.seq !== undefined ? " · No. " + r.data.seq : ""}${r.data.stable === false ? " · not stable" : ""}`));
    tip.hidden = false;
    // Beside the point, on the side with more room, so it never covers it.
    const px = (x(i) * box.clientWidth) / W, right = px < box.clientWidth / 2;
    tip.style.left = Math.max(0, right ? Math.min(px + 14, box.clientWidth - tip.offsetWidth) : px - 14 - tip.offsetWidth) + "px";
    tip.style.top = Math.min(Math.max(0, y(r.data.weight) - tip.offsetHeight / 2), H - tip.offsetHeight) + "px";
  };
  const clear = () => { hover = null; tip.hidden = true; cross.setAttribute("visibility", "hidden"); mark.setAttribute("visibility", "hidden"); };
  s.addEventListener("pointermove", (e) => {
    const b = s.getBoundingClientRect(), px = ((e.clientX - b.left) * W) / b.width;
    pick(pts.length === 1 ? 0 : Math.min(z, Math.max(0, Math.round(((px - L) * z) / (W - L - R)))));
  });
  s.addEventListener("pointerleave", clear);
  s.addEventListener("blur", clear);
  s.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (step) { e.preventDefault(); pick(Math.min(z, Math.max(0, (hover === null ? z + 1 : hover) + step))); }
    if (e.key === "Escape") clear();
  });
  box.replaceChildren(s, tip);
}

// --- data

function take(list) {
  if (!list.length) return;
  state.reports = state.reports.concat(list).slice(-KEEP);
  state.last = list[list.length - 1].id;
  addRows(list);
  showLatest();
  drawChart();
}

function clearLatest() {
  document.querySelector(".weight").classList.remove("error");
  $("weight").textContent = "-";
  $("unit").textContent = "";
  $("flags").replaceChildren(); $("parts").replaceChildren();
  $("now-meta").textContent = "Waiting for the first report. Press the button on the module.";
  $("count").textContent = "";
}

function reset() {
  state.reports = []; state.last = 0;
  $("rows").replaceChildren();
}

function notice(text, open, retry, helper) {
  $("notice").hidden = !text;
  if ($("notice-text").textContent !== (text || "")) $("notice-text").textContent = text || "";
  $("open").hidden = !open;
  $("retry").hidden = !retry;
  $("helper").hidden = !helper;
}

async function showSample() {
  try {
    const list = await (await fetch("sample.json")).json();
    const now = Date.now() / 1000;
    reset();
    state.sample = true;
    take(list.map((data, i) => ({ id: i + 1, received: now - (list.length - i) * 20, data })));
    state.last = 0;
    $("now-label").textContent = "Latest report (sample data)";
  } catch { /* nothing to show */ }
}

function accept(d) {
  if (state.sample) { reset(); state.sample = false; $("now-label").textContent = "Latest report"; clearLatest(); drawChart(); }
  if (d.last < state.last) { reset(); clearLatest(); drawChart(); } // another database
  state.failures = 0;
  state.seen = Date.now();
  state.offset = d.now - Date.now() / 1000;
  state.total = d.total;
  showStatus(d);
  const fresh = d.reports.filter((r) => r.id > state.last);
  take(fresh);
  showSince();
  if (fresh.length || !db.loaded) db.refresh();
}

// The app pushes each report as it comes (server-sent events), either to this page directly or
// to the helper window, which is a page of the app itself.
let events = null;

function follow(route) {
  return new Promise((resolve) => {
    const es = new EventSource(`${route}/api/stream?after=${state.sample ? 0 : state.last}`);
    let open = false;
    const asking = setTimeout(async () => { // a permission prompt is open
      if (!state.reports.length) await showSample();
      if (!open && !helperAlive()) showUnreachable(true);
    }, 2500);
    const limit = setTimeout(() => end(), LOCAL ? 6000 : 60000);
    const end = () => {
      clearTimeout(asking); clearTimeout(limit);
      es.close();
      if (events === es) { events = null; if (state.source === route) state.source = null; }
      resolve(open);
    };
    es.onmessage = (e) => {
      if (!open) { open = true; clearTimeout(asking); clearTimeout(limit); events = es; state.source = route; }
      accept(JSON.parse(e.data));
    };
    es.onerror = end;
    es.stop = end;
  });
}

const helperAlive = () => state.helper !== null && Date.now() - state.helper.seen < 9000;

async function run() {
  for (;;) {
    let was = false;
    if (!helperAlive()) {
      for (const route of routes) {
        if (SAFARI && route.startsWith("http:")) continue; // would only be blocked
        was = await follow(route); // returns when the connection ends
        if (was) { routes = [route, ...routes.filter((x) => x !== route)]; break; }
        if (helperAlive()) break;
      }
      if (!was && !helperAlive()) {
        state.failures++;
        if (!LOCAL && state.failures === 1 && !state.reports.length) await showSample();
        await showUnreachable();
        db.unavailable();
      }
    }
    await new Promise((r) => { run.wake = r; setTimeout(r, was ? 1000 : helperAlive() ? 2000 : 4000); });
  }
}

// The app sends something at least every 5 s; a sleeping computer or tab may hide a lost connection.
function check() {
  if (events && Date.now() - state.seen > 15000) events.stop();
  if (state.source === "helper" && !helperAlive()) { state.source = null; run.wake(); }
  showSince();
}
setInterval(check, 1000);
addEventListener("visibilitychange", () => { if (!document.hidden) { if (events && Date.now() - state.seen > 7000) events.stop(); else if (!events) run.wake && run.wake(); } });
addEventListener("online", () => run.wake && run.wake());

const answers = new Map();
addEventListener("message", (e) => {
  if (LOCAL || e.origin !== HELPER || !e.source || !e.data) return;
  const m = e.data, known = state.helper !== null && state.helper.window === e.source;
  if (m.helper || m.weighlink || m.answer) {
    if (!known) e.source.postMessage({ after: state.sample ? 0 : state.last }, HELPER); // also after a reload of this page
    state.helper = { window: e.source, seen: Date.now() };
  }
  if (m.weighlink && Array.isArray(m.weighlink.reports) && (!events || state.source === "helper")) {
    state.source = "helper";
    accept(m.weighlink);
  }
  if (m.answer && answers.has(m.answer)) { answers.get(m.answer)(m); answers.delete(m.answer); }
});

// --- database

// A query to the app, over whichever way is connected.
async function ask(path) {
  if (state.source === "helper") {
    const id = `${Date.now()}-${Math.random()}`;
    const m = await new Promise((resolve, reject) => {
      answers.set(id, resolve);
      state.helper.window.postMessage({ id, get: path }, HELPER);
      setTimeout(() => { if (answers.delete(id)) reject(new Error("no answer")); }, 20000);
    });
    if (!m.ok) throw new Error("refused");
    return m.text;
  }
  if (state.source === null) throw new Error("not connected");
  const r = await fetch(state.source + path, { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return r.text();
}

const db = {
  loaded: 0, oldest: 0, timer: null, busy: false, again: false,

  query(extra) {
    const q = new URLSearchParams(extra);
    for (const [id, name, plus] of [["f-from", "from", 0], ["f-to", "to", 1]]) {
      const v = $(id).value && new Date($(id).value).getTime();
      if (v) q.set(name, String(v / 1000 + plus)); // "to" includes that second
    }
    for (const n of ["event", "unit", "status", "errors"]) if ($("f-" + n).value) q.set(n, $("f-" + n).value);
    const s = q.toString();
    return s ? "?" + s : "";
  },

  // New reports: show them too, unless older pages are open or an end is set.
  refresh() {
    if (db.timer || db.loaded > 100 || (db.loaded && $("f-to").value)) return;
    db.timer = setTimeout(() => { db.timer = null; db.search(); }, db.loaded ? 1000 : 50);
  },

  async search(more) {
    if (db.busy) { db.again = !more; return; }
    db.busy = true;
    try {
      const d = JSON.parse(await ask("/api/history" + db.query(more ? { before: db.oldest } : {})));
      const body = $("db-rows");
      if (!more) { body.replaceChildren(); db.loaded = 0; }
      for (const r of d.reports) body.append(row(r));
      db.loaded += d.reports.length;
      if (d.reports.length) db.oldest = d.reports[d.reports.length - 1].id;
      for (const n of ["event", "unit", "status"]) db.options($("f-" + n), d.known[n]);
      $("db-count").textContent = `${d.count} of ${Math.max(state.total, d.count)} reports`;
      $("db-scroll").hidden = !d.count;
      $("more").hidden = db.loaded >= d.count;
      $("db-note").textContent = d.count ? "" : "No reports match.";
      $("csv").disabled = !d.count;
      db.tiles(d.units);
    } catch {
      $("db-note").textContent = "The database could not be read.";
    }
    db.busy = false;
    if (db.again) { db.again = false; db.search(); }
  },

  options(select, values) {
    const have = new Set([...select.options].map((o) => o.value));
    for (const v of values) if (!have.has(v)) { const o = el("option", v); o.value = v; select.append(o); }
  },

  tiles(units) {
    const num = (v) => Number(v.toFixed(4)).toLocaleString("en", { maximumFractionDigits: 4 });
    $("tiles").replaceChildren(...units.flatMap((u) => [
      el("div", u.unit || "no unit", "tile unit"),
      ...[["Reports", u.n], ["Total", num(u.sum)], ["Average", num(u.avg)], ["Minimum", num(u.min)], ["Maximum", num(u.max)]].map(([k, v]) => {
        const e = el("div", null, "tile");
        e.append(el("b", v), el("span", k));
        return e;
      })]));
  },

  unavailable() {
    if (!state.sample && db.loaded) return;
    db.loaded = 0;
    $("db-rows").replaceChildren(); $("tiles").replaceChildren();
    $("db-scroll").hidden = true; $("more").hidden = true; $("csv").disabled = true;
    $("db-count").textContent = "";
    $("db-note").textContent = "The database can be read only with live data.";
  },

  async download() {
    $("csv").disabled = true;
    try {
      const url = URL.createObjectURL(new Blob([await ask("/api/export.csv" + db.query({}))], { type: "text/csv" }));
      const a = el("a");
      a.href = url;
      a.download = "reports.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      $("db-note").textContent = "The download failed.";
    }
    $("csv").disabled = false;
  },
};

$("filter").addEventListener("submit", (e) => { e.preventDefault(); db.search(); });
$("filter").addEventListener("reset", () => setTimeout(() => db.search(), 0));
$("today").addEventListener("click", () => {
  const n = new Date();
  $("f-from").value = `${n.getFullYear()}-${two(n.getMonth() + 1)}-${two(n.getDate())}T00:00:00`;
  $("f-to").value = "";
  db.search();
});
$("more").addEventListener("click", () => db.search(true));
$("csv").addEventListener("click", () => db.download());
$("retry").addEventListener("click", () => run.wake && run.wake());
$("helper").addEventListener("click", () => {
  if (!open(HELPER + "/bridge", "weighlink", "popup,width=420,height=230")) notice("The browser blocked the helper window. Allow pop-ups for this site, or open the live page directly.", true, true, true);
});
addEventListener("resize", () => drawChart());
drawChart();
db.unavailable();
run();
