/* BrushBridge UI — heavy lifting lives in core.js */
const $ = s => document.querySelector(s);
const fileInput = $("#file"), drop = $("#drop"), list = $("#list"), convertBtn = $("#convert"), status = $("#status"),
  spacing = $("#spacing"), spacingLabel = $("#spacingLabel"), outname = $("#outname"), mode = $("#mode"),
  abrVersion = $("#abrversion"), invert = $("#invert"), usePresetSpacing = $("#presetspacing"), useThumb = $("#usethumb");
/* item kinds: "preset" (.kpp), "tip" (.gbr/.png/.svg tip file), each with .tip once decoded */
let items = [];

/* ---- file picking (iPadOS can't filter by .kpp/.gbr, so there is no accept= filter) ---- */
const pick = () => { fileInput.value = ""; fileInput.click() };
$("#browse").onclick = e => { e.stopPropagation(); pick() };
drop.onclick = pick;
drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick() } };
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hover") }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hover") }));
drop.addEventListener("drop", e => addFiles(e.dataTransfer.files));
fileInput.onchange = () => addFiles(fileInput.files);
spacing.oninput = () => { spacingLabel.textContent = spacing.value + "%" };
[mode, abrVersion, invert, usePresetSpacing, useThumb].forEach(el => el.onchange = render);

const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "b" + Date.now().toString(36) + Math.random().toString(36).slice(2);
const baseName = n => n.replace(/^.*[\\/]/, "");
const normKey = n => baseName(n).toLowerCase().replace(/\s*\(\d+\)(?=\.[^.]+$)/, "");   // "tip (1).gbr" -> "tip.gbr"

/* ---- browser helpers ---- */
async function inflateWith(format, data) {
  if (!("DecompressionStream" in window)) throw new Error("This browser can't decompress data (update iPadOS/Safari)");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const inflate = d => inflateWith("deflate", d), inflateRaw = d => inflateWith("deflate-raw", d);
function loadImage(bytes, mime) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime })), img = new Image();
    img.onload = () => resolve({ img, url }); img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image decode failed")) }; img.src = url;
  });
}
async function imageBytesToTip(bytes, mime) {
  const { img, url } = await loadImage(bytes, mime);
  let w = img.naturalWidth, h = img.naturalHeight; if (!w || !h) w = h = 512;
  const c = document.createElement("canvas"); c.width = w; c.height = h; const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
  return { width: w, height: h, ink: BB.rgbaToInk(ctx.getImageData(0, 0, w, h).data, w, h) };
}
function inkToDataUrl(tip) {
  const max = 96, s = Math.min(1, max / Math.max(tip.width, tip.height)), w = Math.max(1, Math.round(tip.width * s)), h = Math.max(1, Math.round(tip.height * s));
  const src = document.createElement("canvas"); src.width = tip.width; src.height = tip.height;
  const sx = src.getContext("2d"), id = sx.createImageData(tip.width, tip.height);
  for (let i = 0; i < tip.ink.length; i++) { const v = 255 - tip.ink[i]; id.data[i*4] = id.data[i*4+1] = id.data[i*4+2] = v; id.data[i*4+3] = 255 }
  sx.putImageData(id, 0, 0);
  const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, w, h);
  return c.toDataURL();
}
const isPng = b => b.length > 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71;
const isZip = b => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);

/* ---- adding files ---- */
function addFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    const id = uid(), item = { id, file, kind: "pending", name: file.name.replace(/\.[^.]+$/, ""), key: normKey(file.name), preview: null, tip: null, note: "Reading…" };
    items.push(item);
    readFile(item).catch(err => { item.kind = "error"; item.note = "Could not read this file: " + err.message }).finally(render);
  }
  render();
}
async function readFile(item) {
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  if (isZip(bytes)) return readBundle(item, bytes);
  const gbr = !isPng(bytes) && (BB.parseGbr(bytes) || BB.parseGih(bytes));
  if (gbr) { item.kind = "tip"; item.name = gbr.name || item.name; item.tip = BB.limitSize(BB.gbrToTip(gbr)); item.preview = inkToDataUrl(item.tip); item.spacing = gbr.spacing || null; item.note = "Brush tip file (.gbr)"; return }
  if (/\.svg$/i.test(item.file.name) || /^\s*(<\?xml|<svg)/.test(new TextDecoder("latin1").decode(bytes.subarray(0, 100)))) { item.kind = "tip"; item.tip = BB.limitSize(await imageBytesToTip(bytes, "image/svg+xml")); item.preview = inkToDataUrl(item.tip); item.note = "Brush tip file (SVG)"; return }
  const texts = await BB.readPngTexts(bytes, inflate);           // throws "Not a PNG file" for anything else
  const xml = texts.join("\n");
  const thumbUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  if (!/<Preset\b/.test(xml)) {                                  // plain PNG: the image itself is a tip
    item.kind = "tip"; item.tip = BB.limitSize(await imageBytesToTip(bytes, "image/png")); item.preview = inkToDataUrl(item.tip); item.note = "Brush tip image (PNG)"; return;
  }
  item.kind = "preset"; item.preview = thumbUrl; item.name = BB.presetName(xml) || item.name;
  item.ref = BB.brushParams(xml);
  try { item.fallbackTip = await imageBytesToTip(bytes, "image/png") } catch (e) {}
  for (const r of BB.findResources(xml)) {                       // tips some Krita versions embed directly
    try {
      if (r.kind === "gbr" || r.kind === "gih") { const g = r.kind === "gbr" ? BB.parseGbr(r.bytes) : BB.parseGih(r.bytes); item.embedded = BB.limitSize(BB.gbrToTip(g)); item.embeddedNote = "Embedded brush tip"; break }
      if (r.kind === "png" || r.kind === "jpeg" || r.kind === "svg") { item.embedded = BB.limitSize(await imageBytesToTip(r.bytes, r.kind === "png" ? "image/png" : r.kind === "jpeg" ? "image/jpeg" : "image/svg+xml")); item.embeddedNote = "Embedded " + r.kind.toUpperCase() + " tip"; break }
    } catch (e) { /* try next */ }
  }
}
async function readBundle(item, bytes) {                        // Krita .bundle / .zip: take presets and tips, skip patterns/gradients
  const files = await BB.readZip(bytes, inflateRaw);
  const wanted = files.filter(f => /\.(kpp|gbr|gih|svg|png)$/i.test(f.name) && !/(^|\/)(patterns|gradients|palettes|gamutmasks|workspaces|symbols)\//i.test(f.name));
  item.kind = "bundle"; item.note = `Bundle: unpacked ${wanted.length} file(s)`;
  for (const f of wanted) {
    const file = new File([f.data], baseName(f.name)), id = uid(), sub = { id, file, kind: "pending", name: baseName(f.name).replace(/\.[^.]+$/, ""), key: normKey(f.name), preview: null, tip: null, note: "Reading…" };
    items.push(sub); readFile(sub).catch(err => { sub.kind = "error"; sub.note = "Could not read: " + err.message }).finally(render);
  }
}

/* ---- resolving presets against available tip files ---- */
function resolve() {
  const tips = new Map(); items.filter(i => i.kind === "tip" && i.tip).forEach(i => { i.usedBy = 0; tips.set(i.key, i) });
  for (const b of items) {
    if (b.kind !== "preset") continue;
    b.tip = null; b.needs = null; const ref = b.ref || {};
    if (b.embedded) { b.tip = b.embedded; b.note = b.embeddedNote; continue }
    const hit = ref.filename && tips.get(normKey(ref.filename));
    if (hit) { b.tip = hit.tip; hit.usedBy++; b.note = "Tip from " + baseName(ref.filename); continue }
    if (ref.auto) { b.tip = BB.autoBrushTip(ref.auto); b.note = "Krita built-in round/square brush — approximated as a generated tip"; continue }
    if (ref.filename) { b.needs = baseName(ref.filename); b.note = `Needs the brush tip file “${b.needs}” (not stored inside the preset). Add it, or its .bundle, to this list.` }
    else b.note = "No bitmap tip in this preset (non-bitmap brush engine?)";
  }
}
const tipOf = b => b.tip || (useThumb.checked && b.fallbackTip) || null;
function exportable() { return items.filter(b => (b.kind === "preset" && tipOf(b)) || (b.kind === "tip" && b.tip && !b.usedBy)) }

function render() {
  resolve(); list.innerHTML = "";
  items.filter(b => b.kind !== "bundle").forEach(b => {
    const row = document.createElement("div"); row.className = "brushitem" + (b.needs ? " warn" : "");
    const img = document.createElement("img"); img.className = "thumb"; img.alt = ""; if (b.preview) img.src = b.preview;
    const info = document.createElement("div"); info.className = "binfo";
    const title = document.createElement("strong"); title.textContent = b.name;
    const small = document.createElement("small"), t = tipOf(b);
    let text = b.note || "";
    if (b.kind === "preset" && b.tip) text += ` · ${b.tip.width}×${b.tip.height}px`;
    else if (b.kind === "preset" && t) text = "No tip available — will use the preset thumbnail (rough)";
    else if (b.kind === "tip") text += b.usedBy ? ` · used by ${b.usedBy} preset(s), exported with them` : ` · ${b.tip.width}×${b.tip.height}px · will be exported as its own brush`;
    small.textContent = text; info.append(title, small);
    const remove = document.createElement("button"); remove.className = "remove"; remove.title = "Remove"; remove.textContent = "×";
    remove.onclick = () => { items = items.filter(x => x.id !== b.id); render() };
    row.append(img, info, remove); list.append(row);
  });
  const n = exportable().length, missing = [...new Set(items.filter(b => b.needs).map(b => b.needs))];
  convertBtn.disabled = n === 0;
  convertBtn.firstChild.textContent = mode.value === "zip" ? "Convert & download ZIP " : "Convert & download ABR ";
  status.textContent = !items.length ? "Select one or more KPP files to begin." :
    `${n} brush(es) ready to export.` + (missing.length ? ` Missing tip file(s): ${missing.join(", ")} — add them alongside the presets.` : "");
}

/* ---- export ---- */
function entryFor(b) {
  const t = tipOf(b), sp = (b.kind === "preset" ? b.ref && b.ref.spacing : b.spacing) || null;
  return { name: b.name, width: t.width, height: t.height, ink: t.ink, spacing: usePresetSpacing.checked && sp ? sp : +spacing.value };
}
function download(bytes, filename, type) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([bytes], { type })); a.download = filename; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 4000);
}
const safe = s => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "brush";
convertBtn.onclick = () => {
  const list_ = exportable(); if (!list_.length) return;
  const opts = { sub: +abrVersion.value, invert: invert.checked };
  try {
    const base = outname.value.trim().replace(/\.(abr|zip)$/i, "") || "converted-brushes";
    if (mode.value === "zip") {
      const used = new Set(), files = list_.map(b => { const n = safe(b.name); let k = 2, cand = n; while (used.has(cand.toLowerCase())) cand = n + " " + k++; used.add(cand.toLowerCase()); return { name: cand + ".abr", data: BB.buildAbr([entryFor(b)], opts) } });
      download(BB.zip(files), base + ".zip", "application/zip"); status.textContent = `Exported ${files.length} separate ABR file(s) in a ZIP.`;
    } else {
      download(BB.buildAbr(list_.map(entryFor), opts), base + ".abr", "application/octet-stream"); status.textContent = `Exported ${list_.length} brush(es) into one ABR (Photoshop v6.${opts.sub}).`;
    }
  } catch (err) { status.textContent = "Conversion error: " + err.message }
};
render();
