// KPP → ABR converter. Runs entirely in the browser. Requires pako (CDN).

const state = { brushes: [] };

// ---------- PNG chunk parsing ----------

function parsePngChunks(buffer) {
  const view = new DataView(buffer);
  const sig = new Uint8Array(buffer, 0, 8);
  const pngSig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) {
    if (sig[i] !== pngSig[i]) throw new Error('Not a valid PNG file');
  }
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7)
    );
    if (offset + 12 + length > buffer.byteLength) break;
    chunks.push({ type, data: new Uint8Array(buffer, offset + 8, length) });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function textFromChunk(chunk) {
  if (chunk.type === 'tEXt') {
    const n = chunk.data.indexOf(0);
    if (n < 0) return null;
    return new TextDecoder().decode(chunk.data.slice(n + 1));
  }
  if (chunk.type === 'zTXt') {
    const n = chunk.data.indexOf(0);
    if (n < 0) return null;
    return new TextDecoder().decode(pako.inflate(chunk.data.slice(n + 2)));
  }
  if (chunk.type === 'iTXt') {
    const n = chunk.data.indexOf(0);
    if (n < 0) return null;
    const flag = chunk.data[n + 1];
    let pos = n + 3;
    const langEnd = chunk.data.indexOf(0, pos);
    if (langEnd < 0) return null;
    pos = langEnd + 1;
    const transEnd = chunk.data.indexOf(0, pos);
    if (transEnd < 0) return null;
    pos = transEnd + 1;
    const body = chunk.data.slice(pos);
    return new TextDecoder().decode(flag === 1 ? pako.inflate(body) : body);
  }
  return null;
}

function looksLikeXml(s) {
  if (!s) return false;
  return s.includes('<?xml') || s.includes('<Preset') || s.includes('<preset') || s.includes('<param');
}

function extractXml(chunks) {
  for (const chunk of chunks) {
    if (!['tEXt', 'zTXt', 'iTXt'].includes(chunk.type)) continue;
    try {
      const text = textFromChunk(chunk);
      if (text && looksLikeXml(text)) return stripBom(text);
    } catch (e) {
      console.warn(`Failed to decode ${chunk.type} chunk:`, e);
    }
  }
  return null;
}

// ---------- XML settings ----------

function parseXmlSettings(xmlString) {
  const cleaned = xmlString.replace(/<!DOCTYPE[^>]*>/i, '');
  const doc = new DOMParser().parseFromString(cleaned, 'application/xml');
  const preset = doc.querySelector('preset, Preset, paintoppreset');

  const params = {};
  doc.querySelectorAll('param').forEach(p => {
    const n = p.getAttribute('name');
    if (n) params[n] = p.textContent;
  });

  const pick = (...keys) => {
    for (const k of keys) {
      if (params[k] != null) {
        const v = parseFloat(params[k]);
        if (!isNaN(v)) return v;
      }
    }
    return null;
  };

  return {
    name: preset?.getAttribute('name') || null,
    size: pick('brush_size', 'size', 'diameter'),
    spacing: pick('spacing', 'brush_spacing'),
  };
}

// ---------- Brush tip extraction ----------

async function loadPngAsImage(buffer) {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'image/png' }));
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Failed to decode PNG image'));
    img.src = url;
  });
  return img;
}

function imageToTipData(img) {
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height).data;

  const total = width * height;
  let aMin = 255, aMax = 0;
  for (let i = 0; i < total; i++) {
    const a = pixels[i * 4 + 3];
    if (a < aMin) aMin = a;
    if (a > aMax) aMax = a;
  }
  const useAlpha = (aMax - aMin) > 4;

  const tip = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (useAlpha) {
      tip[i] = pixels[i * 4 + 3];
    } else {
      const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2];
      tip[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
  }
  return { tip, width, height, useAlpha };
}

function padToSquare(tip, width, height) {
  const size = Math.max(width, height);
  if (width === height) return { tip, size };
  const out = new Uint8Array(size * size);
  const offX = Math.floor((size - width) / 2);
  const offY = Math.floor((size - height) / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[(y + offY) * size + (x + offX)] = tip[y * width + x];
    }
  }
  return { tip: out, size };
}

function downsample(tip, size, maxSize) {
  if (size <= maxSize) return { tip, size };
  const out = new Uint8Array(maxSize * maxSize);
  const scale = size / maxSize;
  for (let y = 0; y < maxSize; y++) {
    for (let x = 0; x < maxSize; x++) {
      out[y * maxSize + x] = tip[Math.floor(y * scale) * size + Math.floor(x * scale)];
    }
  }
  return { tip: out, size: maxSize };
}

function makeThumbnail(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 48; canvas.height = 48;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 48, 48);
  ctx.drawImage(img, 0, 0, 48, 48);
  return canvas.toDataURL();
}

async function processKppFile(file) {
  const debug = [];
  debug.push(`File: ${file.name} (${file.size} bytes)`);

  const buffer = await file.arrayBuffer();
  const chunks = parsePngChunks(buffer);
  debug.push(`PNG valid. Chunks: ${chunks.map(c => `${c.type}(${c.data.length})`).join(', ')}`);

  const xml = extractXml(chunks);
  if (xml) debug.push(`XML found (${xml.length} chars)`);
  else debug.push('No XML metadata found — using defaults');

  let settings = { name: file.name.replace(/\.kpp$/i, ''), size: null, spacing: null };
  if (xml) {
    try {
      const parsed = parseXmlSettings(xml);
      debug.push(`Parsed settings: ${JSON.stringify(parsed)}`);
      if (parsed.name) settings.name = parsed.name;
      if (parsed.size != null) settings.size = parsed.size;
      if (parsed.spacing != null) settings.spacing = parsed.spacing;
    } catch (e) {
      debug.push(`XML parse failed: ${e.message}`);
    }
  }

  const img = await loadPngAsImage(buffer);
  debug.push(`Image: ${img.naturalWidth}×${img.naturalHeight}`);

  const { tip, width, height, useAlpha } = imageToTipData(img);
  debug.push(`Tip source: ${useAlpha ? 'alpha channel' : 'luminance'}`);
  const square = padToSquare(tip, width, height);
  const { tip: finalTip, size: finalSize } = downsample(square.tip, square.size, 2500);
  debug.push(`Final tip: ${finalSize}×${finalSize} (${finalTip.length} bytes)`);

  let spacingPct = 25;
  if (settings.spacing != null) {
    spacingPct = settings.spacing < 10
      ? Math.round(settings.spacing * 100)
      : Math.round(settings.spacing);
  }
  spacingPct = Math.max(1, Math.min(1000, spacingPct));
  debug.push(`Spacing: ${spacingPct}%`);

  return {
    name: settings.name || file.name.replace(/\.kpp$/i, ''),
    width: finalSize,
    height: finalSize,
    tipData: finalTip,
    spacing: spacingPct,
    thumbnail: makeThumbnail(img),
    sourceFile: file.name,
    debug: debug.join('\n'),
  };
}

// ---------- ABR writer (v2, subversion 1, sampled brush) ----------
// Note on the format:
//   Header: uint16 version (2), uint16 subversion (1), uint32 count
//   Per sampled brush (all big-endian):
//     uint32 type (2 = sampled)
//     uint32 size (brush diameter)
//     uint32 spacing (percent)
//     Pascal string name (1-byte length + chars, padded to 4-byte boundary)
//     uint32 antialiasing
//     int32 bounds top, int32 bounds left, int32 bounds bottom, int32 bounds right
//     uint16 depth (bits per pixel, 8)
//     uint16 compression (0 = raw)
//     width*height bytes of tip data

function buildAbr(brushes) {
  const encoder = new TextEncoder();

  const prepared = brushes.map(brush => {
    const clean = (brush.name || 'Brush').replace(/[\x00-\x1F\x7F]/g, '').substring(0, 255);
    const nameBytes = encoder.encode(clean);
    const nameLen = nameBytes.length;
    const nameTotal = 1 + nameLen;                  // length byte + chars
    const namePadded = Math.ceil(nameTotal / 4) * 4;
    return { brush, nameBytes, nameLen, namePadded };
  });

  let total = 2 + 2 + 4; // header
  for (const p of prepared) {
    total += 4 + 4 + 4;                            // type, size, spacing
    total += p.namePadded;                         // pascal name (padded)
    total += 4;                                    // antialiasing
    total += 4 + 4 + 4 + 4;                        // bounds
    total += 2 + 2;                                // depth, compression
    total += p.brush.tipData.length;
  }

  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let o = 0;

  view.setUint16(o, 2, false); o += 2;             // version
  view.setUint16(o, 1, false); o += 2;             // subversion
  view.setUint32(o, prepared.length, false); o += 4;

  for (const p of prepared) {
    const b = p.brush;

    view.setUint32(o, 2, false); o += 4;           // sampled brush
    view.setUint32(o, b.width, false); o += 4;     // size
    view.setUint32(o, b.spacing, false); o += 4;   // spacing

    // Pascal name
    view.setUint8(o, p.nameLen); o += 1;
    bytes.set(p.nameBytes, o); o += p.nameLen;
    o += p.namePadded - (1 + p.nameLen);           // padding to 4-byte boundary

    view.setUint32(o, 1, false); o += 4;           // antialiasing

    view.setInt32(o, 0, false); o += 4;            // top
    view.setInt32(o, 0, false); o += 4;            // left
    view.setInt32(o, b.height, false); o += 4;     // bottom
    view.setInt32(o, b.width, false); o += 4;      // right

    view.setUint16(o, 8, false); o += 2;           // depth = 8 bpp
    view.setUint16(o, 0, false); o += 2;           // compression = raw

    bytes.set(b.tipData, o); o += b.tipData.length;
  }

  if (o !== total) {
    console.error(`ABR size mismatch: wrote ${o}, expected ${total}`);
  }
  return new Blob([buffer], { type: 'application/octet-stream' });
}

// ---------- UI ----------

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const outputSection = document.getElementById('output-section');
const brushList = document.getElementById('brush-list');
const downloadBtn = document.getElementById('download-btn');
const statusEl = document.getElementById('status');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

browseBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files);
  if (files.length) await handleFiles(files);
});
fileInput.addEventListener('change', async e => {
  const files = Array.from(e.target.files);
  if (files.length) await handleFiles(files);
  fileInput.value = '';
});

async function handleFiles(files) {
  const valid = files.filter(f => /\.(kpp|png)$/i.test(f.name));
  if (!valid.length) { setStatus('No .kpp files in selection.', true); return; }

  setStatus(`Processing ${valid.length} file(s)...`);
  state.brushes = [];

  for (const file of valid) {
    try {
      console.log(`[KPP→ABR] Processing ${file.name}`);
      const brush = await processKppFile(file);
      console.log(`[KPP→ABR] Brush extracted:`, brush);
      state.brushes.push({ ...brush, error: null });
    } catch (err) {
      console.error(`[KPP→ABR] Failed on ${file.name}:`, err);
      state.brushes.push({ sourceFile: file.name, name: file.name, error: err.message });
    }
  }

  renderBrushes();
  outputSection.classList.remove('hidden');

  const ok = state.brushes.filter(b => !b.error).length;
  setStatus(`Processed ${ok} of ${valid.length} file(s).`, ok === 0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderBrushes() {
  brushList.innerHTML = '';
  for (const brush of state.brushes) {
    const div = document.createElement('div');
    div.className = 'brush-item';
    if (brush.error) {
      div.innerHTML = `
        <div class="brush-meta">
          <div class="brush-name">${escapeHtml(brush.sourceFile)}</div>
          <div class="brush-error">Error: ${escapeHtml(brush.error)}</div>
        </div>`;
    } else {
      div.innerHTML = `
        <img class="brush-thumb" src="${brush.thumbnail}" alt="">
        <div class="brush-meta">
          <div class="brush-name">${escapeHtml(brush.name)}</div>
          <div class="brush-info">${brush.width}×${brush.height}px · spacing ${brush.spacing}%</div>
          <details style="margin-top:.35rem;font-size:.8rem;">
            <summary style="cursor:pointer;color:#4a7cff;">Debug info</summary>
            <pre style="white-space:pre-wrap;background:#f5f5f5;padding:.5rem;border-radius:4px;font-size:.75rem;margin:.35rem 0 0;">${escapeHtml(brush.debug || '')}</pre>
          </details>
        </div>`;
    }
    brushList.appendChild(div);
  }
}

function sanitizeFilename(name) {
  return (name || 'brush').replace(/[^a-z0-9_\- ]/gi, '_').replace(/\s+/g, '_').substring(0, 100) || 'brush';
}

downloadBtn.addEventListener('click', () => {
  const valid = state.brushes.filter(b => !b.error);
  if (!valid.length) { setStatus('No brushes to download.', true); return; }
  try {
    const blob = buildAbr(valid);
    console.log(`[KPP→ABR] Built ABR: ${blob.size} bytes for ${valid.length} brush(es)`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = valid.length === 1
      ? `${sanitizeFilename(valid[0].name)}.abr`
      : 'converted-brushes.abr';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Download started (${blob.size} bytes).`);
  } catch (err) {
    console.error('[KPP→ABR] ABR build failed:', err);
    setStatus('Failed to build ABR: ' + err.message, true);
  }
});