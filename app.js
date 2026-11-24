// Everything shown comes from the network, so it is only ever set as text, never as HTML.
"use strict";

const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const API = LOCAL ? "" : "http://localhost:8080"; // the pages may also be hosted elsewhere
const KEEP = 500, POINTS = 100;
const $ = (id) => document.getElementById(id);
const state = { reports: [], last: 0, offset: 0, failures: 0, sample: false, loading: false };

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

function setState(id, text, ok) {
  const e = $(id);
  e.className = "state" + (ok === true ? " ok" : ok === false ? " no" : "");
  e.querySelector("b").textContent = text;
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
  $("count").textContent = `${state.reports.length} received` + (bad ? `, ${bad} without a valid reading` : "");
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
  const { ticks, digits } = niceTicks(Math.min(0, ...ws), Math.max(...ws, 0));
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

function reset() {
  state.reports = []; state.last = 0;
  $("rows").replaceChildren();
}

function notice(text) {
  $("notice").hidden = !text;
  $("notice").textContent = text || "";
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

async function poll() {
  try {
    const r = await fetch(`${API}/api/reports?after=${state.sample ? 0 : state.last}`, { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    if (state.sample) { reset(); state.sample = false; $("now-label").textContent = "Latest report"; drawChart(); }
    if (d.last < state.last) { reset(); drawChart(); } // the server was restarted
    state.failures = 0;
    setState("s-server", "connected", true);
    setState("s-broker", d.broker ? "connected" : "not connected", d.broker);
    setState("s-module", !d.broker ? "unknown" : d.module || "unknown", !d.broker || !d.module ? undefined : d.module === "online");
    notice(d.broker ? "" : "The server is not connected to the MQTT broker. It keeps trying.");
    take(d.reports);
  } catch {
    state.failures++;
    setState("s-server", "not reachable", false);
    setState("s-broker", "unknown"); setState("s-module", "unknown");
    if (state.failures === 1 && !state.reports.length) await showSample();
    notice(state.sample ? "Sample data, not live. The server on this computer is not running (web/run.sh), or the browser blocks access to it."
      : "The server on this computer does not answer. The reports below are the last ones received.");
  } finally {
    setTimeout(poll, state.failures ? 4000 : 1000);
  }
}

addEventListener("resize", () => drawChart());
drawChart();
poll();
