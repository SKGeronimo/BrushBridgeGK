/* BrushBridge UI — heavy lifting lives in core.js */
const $ = s => document.querySelector(s);
const fileInput = $("#file"), drop = $("#drop"), list = $("#list"), convertBtn = $("#convert"), status = $("#status"),
  spacing = $("#spacing"), spacingLabel = $("#spacingLabel"), outname = $("#outname"), mode = $("#mode"),
  abrVersion = $("#abrversion"), invert = $("#invert"), usePresetSpacing = $("#presetspacing"), useThumb = $("#usethumb");
let brushes = [];

/* ---- file picking (iPadOS can't filter by .kpp, so there is no accept= filter) ---- */
$("#browse").onclick = e => { e.stopPropagation(); fileInput.value = ""; fileInput.click() };
drop.onclick = () => { fileInput.value = ""; fileInput.click() };
drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.value = ""; fileInput.click() } };
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hover") }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hover") }));
drop.addEventListener("drop", e => addFiles(e.dataTransfer.files));
fileInput.onchange = () => addFiles(fileInput.files);
spacing.oninput = () => spacingLabel.textContent = spacing.value + "%";
[mode, abrVersion, invert, usePresetSpacing, useThumb].forEach(el => el.onchange = render);

const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "b" + Date.now().toString(36) + Math.random().toString(36).slice(2);

function addFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    const id = uid();
    brushes.push({ id, file, name: file.name.replace(/\.(kpp|png)$/i, ""), preview: null, tip: null, spacing: null, note: "Reading preset…", fallbackTip: null });
    readFile(file).then(r => Object.assign(brushes.find(b => b.id === id) || {}, r)).catch(err => {
      const b = brushes.find(x => x.id === id); if (b) b.note = "Could not read this file: " + err.message;
    }).finally(render);
  }
  render();
}

/* ---- reading ---- */
async function inflate(data) {
  if (!("DecompressionStream" in window)) throw new Error("This browser can't decompress PNG text (update iPadOS/Safari)");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function loadImage(bytes, mime) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime })), img = new Image();
    img.onload = () => resolve({ img, url }); img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image decode failed")) }; img.src = url;
  });
}
async function imageBytesToTip(bytes, mime) {
  const { img, url } = await loadImage(bytes, mime);
  let w = img.naturalWidth, h = img.naturalHeight; if (!w || !h) { w = h = 512 }
  const c = document.createElement("canvas"); c.width = w; c.height = h; const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
  return { width: w, height: h, ink: BB.rgbaToInk(ctx.getImageData(0, 0, w, h).data, w, h) };
}
function inkToDataUrl(tip) {
  const max = 96, s = Math.min(1, max / Math.max(tip.width, tip.height)), w = Math.max(1, Math.round(tip.width * s)), h = Math.max(1, Math.round(tip.height * s));
  const src = document.createElement("canvas"); src.width = tip.width; src.height = tip.height;
  const id = src.getContext("2d").createImageData(tip.width, tip.height);
  for (let i = 0; i < tip.ink.length; i++) { const v = 255 - tip.ink[i]; id.data[i*4] = id.data[i*4+1] = id.data[i*4+2] = v; id.data[i*4+3] = 255 }
  src.getContext("2d").putImageData(id, 0, 0);
  const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, w, h);
  return c.toDataURL();
}
async function readFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const texts = await BB.readPngTexts(bytes, inflate);            // throws "Not a PNG file" for other data
  const xml = texts.join("\n");
  const thumbUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const out = { preview: thumbUrl, fallbackTip: null, tip: null };
  try { out.fallbackTip = await imageBytesToTip(bytes, "image/png") } catch (e) {}

  if (!/<Preset\b/.test(xml)) {                                    // plain PNG: treat the image itself as the tip
    out.tip = out.fallbackTip; out.note = out.tip ? "Plain PNG used directly as a tip" : "Could not decode this image"; out.fallbackTip = null;
    if (out.tip) out.preview = inkToDataUrl(out.tip); return out;
  }
  const nm = BB.presetName(xml); if (nm) out.name = nm;
  const params = BB.brushParams(xml); out.spacing = params.spacing;
  const res = BB.findResources(xml);
  for (const r of res) {
    try {
      if (r.kind === "gbr") { out.tip = BB.gbrToTip(BB.parseGbr(r.bytes)); out.note = "Embedded GIMP brush tip (.gbr)"; break }
      if (r.kind === "gih") { out.tip = BB.gbrToTip(BB.parseGih(r.bytes)); out.note = "Embedded animated tip (first frame used)"; break }
      if (r.kind === "png" || r.kind === "jpeg" || r.kind === "svg") { out.tip = await imageBytesToTip(r.bytes, r.kind === "png" ? "image/png" : r.kind === "jpeg" ? "image/jpeg" : "image/svg+xml"); out.note = "Embedded " + r.kind.toUpperCase() + " tip"; break }
    } catch (e) { /* try next resource */ }
  }
  if (!out.tip && params.auto) { out.tip = BB.autoBrushTip(params.auto); out.note = "Krita built-in round/square brush — approximated as a generated tip" }
  if (!out.tip) out.note = res.length ? "Embedded resources found but none was a usable brush tip" : "No bitmap tip in this preset (it may reference a brush file that isn't embedded, or use a non-bitmap engine)";
  if (out.tip) { out.tip = BB.limitSize(out.tip); out.preview = inkToDataUrl(out.tip) }
  return out;
}

/* ---- list ---- */
function usable() { return brushes.filter(b => b.tip || (useThumb.checked && b.fallbackTip)) }
function tipOf(b) { return b.tip || b.fallbackTip }
function render() {
  list.innerHTML = "";
  brushes.forEach(b => {
    const item = document.createElement("div"); item.className = "brushitem";
    const img = document.createElement("img"); img.className = "thumb"; img.alt = ""; if (b.preview) img.src = b.preview;
    const info = document.createElement("div"); info.className = "binfo";
    const title = document.createElement("strong"); title.textContent = b.name;
    const small = document.createElement("small");
    const t = tipOf(b);
    small.textContent = b.tip ? `${b.note} · ${b.tip.width}×${b.tip.height}px` : (t ? "No tip found — will use the preset thumbnail (rough)" : b.note);
    info.append(title, small);
    const remove = document.createElement("button"); remove.className = "remove"; remove.title = "Remove"; remove.textContent = "×";
    remove.onclick = () => { brushes = brushes.filter(x => x.id !== b.id); render() };
    item.append(img, info, remove); list.append(item);
  });
  const n = usable().length;
  convertBtn.disabled = n === 0;
  convertBtn.firstChild.textContent = mode.value === "zip" ? "Convert & download ZIP " : "Convert & download ABR ";
  status.textContent = brushes.length ? `${brushes.length} file(s) loaded · ${n} ready to export · ${brushes.length - n} without a usable tip.` : "Select one or more KPP files to begin.";
}

/* ---- export ---- */
function entryFor(b) {
  const t = tipOf(b);
  return { name: b.name, width: t.width, height: t.height, ink: t.ink, spacing: usePresetSpacing.checked && b.spacing ? b.spacing : +spacing.value };
}
function download(bytes, filename, type) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([bytes], { type })); a.download = filename; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 4000);
}
const safe = s => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "brush";
convertBtn.onclick = () => {
  const items = usable(); if (!items.length) return;
  const opts = { sub: +abrVersion.value, invert: invert.checked };
  try {
    let base = outname.value.trim().replace(/\.(abr|zip)$/i, "") || "converted-brushes";
    if (mode.value === "zip") {
      const used = new Set(), files = items.map(b => { let n = safe(b.name), k = 2, cand = n; while (used.has(cand.toLowerCase())) cand = n + " " + k++; used.add(cand.toLowerCase()); return { name: cand + ".abr", data: BB.buildAbr([entryFor(b)], opts) } });
      download(BB.zip(files), base + ".zip", "application/zip");
      status.textContent = `Exported ${files.length} separate ABR file(s) in a ZIP.`;
    } else {
      download(BB.buildAbr(items.map(entryFor), opts), base + ".abr", "application/octet-stream");
      status.textContent = `Exported ${items.length} brush(es) into one ABR (Photoshop v6.${opts.sub}).`;
    }
  } catch (err) { status.textContent = "Conversion error: " + err.message }
};
render();
