/* BrushBridge core — no DOM access, so it runs in browsers and Node.
 * Reading: Krita .kpp (PNG with preset XML + embedded resources)
 * Writing: Photoshop ABR v6.1 / v6.2 ('samp' tips + 'desc' presets), the layout Adobe apps load.
 * "ink" arrays everywhere are 0..255 where 255 = fully opaque paint. */
(function (root) {
"use strict";
const BB = {};

/* ---------- byte helpers ---------- */
const concat = chunks => { let n = 0; for (const c of chunks) n += c.length; const o = new Uint8Array(n); let p = 0; for (const c of chunks) { o.set(c, p); p += c.length } return o };
const be16 = v => Uint8Array.of((v >> 8) & 255, v & 255);
const be32 = v => Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const f64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, false); return b };
const ascii = s => { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 255; return o };
const u32at = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const utf8 = b => { try { return new TextDecoder("utf-8", { fatal: true }).decode(b) } catch { return new TextDecoder("latin1").decode(b) } };
const b64decode = s => {
  if (typeof atob === "function") { const r = atob(s); const o = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o }
  return new Uint8Array(Buffer.from(s, "base64"));
};
BB.concat = concat;

/* ---------- PNG text chunks (Krita keeps the preset XML here) ---------- */
BB.readPngTexts = async function (bytes, inflate) {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error("Not a PNG file");
  const texts = []; let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = u32at(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    try {
      if (type === "tEXt") { const z = data.indexOf(0); if (z >= 0) texts.push(utf8(data.subarray(z + 1))) }
      else if (type === "zTXt") { const z = data.indexOf(0); if (z >= 0) texts.push(utf8(await inflate(data.subarray(z + 2)))) }
      else if (type === "iTXt") {
        let p = data.indexOf(0); if (p >= 0) {
          const compressed = data[p + 1] === 1; p += 3;                  // flag + method
          while (p < data.length && data[p] !== 0) p++; p++;             // language tag
          while (p < data.length && data[p] !== 0) p++; p++;             // translated keyword
          const body = data.subarray(p);
          texts.push(compressed ? utf8(await inflate(body)) : utf8(body));
        }
      }
    } catch (e) { /* ignore unreadable chunk */ }
    pos += 12 + len;
    if (type === "IEND") break;
  }
  return texts;
};

/* ---------- GIMP .gbr (what Krita embeds for bitmap tips) ---------- */
BB.parseGbr = function (b) {
  if (b.length < 28) return null;
  const hs = u32at(b, 0), ver = u32at(b, 4), w = u32at(b, 8), h = u32at(b, 12), bpp = u32at(b, 16);
  if ((ver !== 1 && ver !== 2) || w < 1 || h < 1 || w > 16384 || h > 16384 || ![1, 2, 3, 4].includes(bpp) || hs < 20 || hs > 4096) return null;
  if (hs + w * h * bpp > b.length) return null;
  let spacing = null, nameStart = 20;
  if (ver === 2) { if (u32at(b, 20) !== 0x47494d50) return null; spacing = u32at(b, 24); nameStart = 28 }
  let ne = nameStart; while (ne < hs && b[ne] !== 0) ne++;
  return { width: w, height: h, bpp, spacing, name: utf8(b.subarray(nameStart, ne)), data: b.subarray(hs, hs + w * h * bpp) };
};
/* .gih image pipes start with two text lines, then a normal gbr */
BB.parseGih = function (b) {
  let p = 0, lines = 0; while (p < b.length && p < 512 && lines < 2) { if (b[p] === 10) lines++; p++ }
  return lines === 2 ? BB.parseGbr(b.subarray(p)) : null;
};

/* ---------- pixel conversion ---------- */
BB.rgbaToInk = function (rgba, w, h) {
  const n = w * h; const ink = new Uint8Array(n); let hasAlpha = false;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] < 250) { hasAlpha = true; break }
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    // transparent images carry the shape in alpha; opaque images carry it in darkness
    ink[i] = hasAlpha ? a : Math.round(255 - (0.2126 * r + 0.7152 * g + 0.0722 * b));
  }
  return ink;
};
BB.gbrToTip = function (g) {
  const { width: w, height: h, bpp, data } = g; const n = w * h; let ink;
  if (bpp === 1) { ink = new Uint8Array(n); for (let i = 0; i < n; i++) ink[i] = 255 - data[i] }   // gbr gray: black = paint
  else { const rgba = new Uint8Array(n * 4); for (let i = 0; i < n; i++) {
      if (bpp === 2) { rgba[i*4] = rgba[i*4+1] = rgba[i*4+2] = data[i*2]; rgba[i*4+3] = data[i*2+1] }
      else if (bpp === 3) { rgba[i*4] = data[i*3]; rgba[i*4+1] = data[i*3+1]; rgba[i*4+2] = data[i*3+2]; rgba[i*4+3] = 255 }
      else { rgba[i*4] = data[i*4]; rgba[i*4+1] = data[i*4+1]; rgba[i*4+2] = data[i*4+2]; rgba[i*4+3] = data[i*4+3] } }
    ink = BB.rgbaToInk(rgba, w, h); }
  return { width: w, height: h, ink };
};
/* Photoshop tips top out around 2500 px; box-average down if larger */
BB.limitSize = function (tip, max = 2500) {
  const { width: w, height: h, ink } = tip; const s = Math.max(w, h) / max; if (s <= 1) return tip;
  const nw = Math.max(1, Math.round(w / s)), nh = Math.max(1, Math.round(h / s)); const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const x0 = Math.floor(x * w / nw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / nw)), y0 = Math.floor(y * h / nh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / nh));
    let sum = 0, c = 0; for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += ink[yy * w + xx]; c++ }
    out[y * nw + x] = Math.round(sum / c);
  }
  return { width: nw, height: nh, ink: out };
};

/* ---------- Krita preset XML ---------- */
const unescapeXml = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
BB.presetName = xml => { const m = /<Preset\b[^>]*?\sname="([^"]*)"/.exec(xml); return m ? unescapeXml(m[1]) : null };
BB.brushParams = function (xml) {
  const x = unescapeXml(unescapeXml(xml)); // brush_definition is XML nested inside an XML attribute/CDATA
  const out = { spacing: null, auto: null };
  const bt = /<Brush\b[^>]*>/.exec(x);
  if (bt) {
    const sp = /\bspacing="([\d.eE+-]+)"/.exec(bt[0]); if (sp && isFinite(+sp[1])) out.spacing = Math.max(1, Math.min(999, Math.round(+sp[1] * 100)));
    if (/type="auto_brush"/.test(bt[0])) {
      const mg = /<MaskGenerator\b[^>]*>/.exec(x); const attr = (n, d) => { const m = mg && new RegExp("\\b" + n + '="([^"]*)"').exec(mg[0]); return m && isFinite(+m[1]) ? +m[1] : d };
      out.auto = { shape: mg && /type="rect"/.test(mg[0]) ? "rect" : "circle", ratio: attr("ratio", 1), hfade: attr("hfade", 0.5), vfade: attr("vfade", 0.5) };
    }
  }
  return out;
};
/* Krita's built-in round/square "auto" brushes have no bitmap, so draw an equivalent soft tip */
BB.autoBrushTip = function (a, size = 256) {
  const w = size, h = Math.max(8, Math.round(size * Math.min(1, a.ratio || 1))), ink = new Uint8Array(w * h);
  const fade = Math.max(0.001, Math.min(1, (a.hfade + a.vfade) / 2 || 0.001));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = (x + 0.5) / w * 2 - 1, ny = (y + 0.5) / h * 2 - 1;
    const d = a.shape === "rect" ? Math.max(Math.abs(nx), Math.abs(ny)) : Math.hypot(nx, ny);
    const v = d <= 1 - fade ? 1 : d >= 1 ? 0 : (1 - d) / fade;
    ink[y * w + x] = Math.round(255 * v * v * (3 - 2 * v) * 1);
  }
  return { width: w, height: h, ink };
};

/* ---------- embedded resources ---------- */
function classify(bytes) {
  if (bytes.length > 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "png";
  if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216) return "jpeg";
  const g = BB.parseGbr(bytes); if (g) return "gbr";
  if (BB.parseGih(bytes)) return "gih";
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 300)); if (/<svg[\s>]/i.test(head)) return "svg";
  return null;
}
BB.findResources = function (xml) {
  const found = [];
  const re = /<resource\b([^>]*)>([\s\S]*?)<\/resource>/gi; let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1], get = n => { const r = new RegExp("\\b" + n + '="([^"]*)"').exec(attrs); return r ? unescapeXml(r[1]) : "" };
    const b64 = m[2].replace(/<!\[CDATA\[|\]\]>|&#x?[0-9a-fA-F]+;|\s+/g, "");
    if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) continue;
    try { const bytes = b64decode(b64), kind = classify(bytes); if (kind) found.push({ type: get("type"), name: get("name") || get("filename"), kind, bytes }) } catch (e) {}
  }
  if (!found.length) { // older layouts: scan for any long base64 run
    const flat = xml.replace(/&#x?[0-9a-fA-F]+;|\s+/g, ""); const rr = /[A-Za-z0-9+/]{200,}={0,2}/g; let k;
    while ((k = rr.exec(flat))) { try { const bytes = b64decode(k[0]), kind = classify(bytes); if (kind) found.push({ type: "", name: "", kind, bytes }) } catch (e) {} }
  }
  found.sort((a, b) => (b.type === "brushes") - (a.type === "brushes")); // brush tips before textures/patterns
  return found;
};

/* ---------- ABR v6 writer ---------- */
function ucs2(s) { const b = new Uint8Array(4 + (s.length + 1) * 2), dv = new DataView(b.buffer); dv.setUint32(0, s.length + 1); for (let i = 0; i < s.length; i++) dv.setUint16(4 + i * 2, s.charCodeAt(i)); return b }
const dkey = k => k.length === 4 ? concat([be32(0), ascii(k)]) : concat([be32(k.length), ascii(k)]);
const iText = (k, v) => concat([dkey(k), ascii("TEXT"), ucs2(v)]);
const iUnit = (k, u, v) => concat([dkey(k), ascii("UntF"), ascii(u), f64(v)]);
const iBool = (k, v) => concat([dkey(k), ascii("bool"), Uint8Array.of(v ? 1 : 0)]);
const descBody = (cls, items) => concat([ucs2(""), dkey(cls), be32(items.length), ...items]);
const iObjc = (k, cls, items) => concat([dkey(k), ascii("Objc"), descBody(cls, items)]);

function packRow(row) {
  const out = []; const n = row.length; let i = 0;
  while (i < n) {
    let r = 1; while (i + r < n && row[i + r] === row[i] && r < 128) r++;
    if (r >= 2) { out.push(257 - r, row[i]); i += r }
    else { const s = i; i++; while (i < n && i - s < 128 && !(i + 1 < n && row[i] === row[i + 1])) i++; out.push(i - s - 1); for (let k = s; k < i; k++) out.push(row[k]) }
  }
  return Uint8Array.from(out);
}
function rle(px, w, h) {
  const rows = [], counts = new Uint8Array(h * 2);
  for (let y = 0; y < h; y++) { const r = packRow(px.subarray(y * w, (y + 1) * w)); rows.push(r); counts[y * 2] = (r.length >> 8) & 255; counts[y * 2 + 1] = r.length & 255 }
  return concat([counts, ...rows]);
}
function uuid() {
  const b = new Uint8Array(16); (root.crypto || require("crypto").webcrypto).getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function sampRecord(id, w, h, px, sub) {
  const mystery = new Uint8Array(sub === 1 ? 10 : 264); const dv = new DataView(mystery.buffer); dv.setInt16(2, 0); dv.setInt16(4, h); dv.setInt16(6, w);
  const payload = concat([Uint8Array.of(36), ascii(id), mystery, be32(0), be32(0), be32(h), be32(w), be16(8), Uint8Array.of(1), rle(px, w, h)]);
  return concat([be32(payload.length), payload, new Uint8Array((4 - payload.length % 4) % 4)]);
}
const section = (tag, data) => concat([ascii("8BIM"), ascii(tag), be32(data.length), data]);

/* entries: [{name,width,height,ink,spacing}] — opts: {sub:1|2, invert:boolean} */
BB.buildAbr = function (entries, opts = {}) {
  const sub = opts.sub === 1 ? 1 : 2, samples = [], presets = [];
  for (const e of entries) {
    const id = uuid(); let px = e.ink;
    if (opts.invert) { px = new Uint8Array(e.ink.length); for (let i = 0; i < px.length; i++) px[i] = 255 - e.ink[i] }
    samples.push(sampRecord(id, e.width, e.height, px, sub));
    const sp = Math.max(1, Math.min(999, Math.round(e.spacing || 25)));
    presets.push(concat([ascii("Objc"), descBody("Brsh", [
      iText("Nm  ", e.name),
      iObjc("Brsh", "sampledBrush", [iUnit("Dmtr", "#Pxl", Math.max(e.width, e.height)), iUnit("Angl", "#Ang", 0), iUnit("Rndn", "#Prc", 100), iUnit("Spcn", "#Prc", sp), iBool("Intr", true), iBool("flipX", false), iBool("flipY", false), iText("sampledData", id)])
    ])]));
  }
  const list = concat([dkey("Brsh"), ascii("VlLs"), be32(presets.length), ...presets]);
  const desc = concat([be32(16), descBody("null", [list])]);
  return concat([be16(6), be16(sub), section("samp", concat(samples)), section("patt", new Uint8Array(0)), section("desc", desc)]);
};

/* ---------- minimal ZIP (store only) so many brushes can be saved as separate .abr files ---------- */
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 };
const le16 = v => Uint8Array.of(v & 255, (v >> 8) & 255), le32 = v => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
BB.zip = function (files) {
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name), crc = crc32(f.data);
    const local = concat([le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(0), le16(0x21), le32(crc), le32(f.data.length), le32(f.data.length), le16(name.length), le16(0), name]);
    parts.push(local, f.data);
    central.push(concat([le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(0), le16(0), le16(0x21), le32(crc), le32(f.data.length), le32(f.data.length), le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), name]));
    offset += local.length + f.data.length;
  }
  const cd = concat(central);
  return concat([...parts, cd, le32(0x06054b50), le16(0), le16(0), le16(files.length), le16(files.length), le32(cd.length), le32(offset), le16(0)]);
};

if (typeof module !== "undefined" && module.exports) module.exports = BB; else root.BB = BB;
})(typeof window !== "undefined" ? window : globalThis);
