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

function extractXml(chunks) {
  for (const chunk of chunks) {
    try {
      if (chunk.type === 'tEXt') {
        const n = chunk.data.indexOf(0);
        if (n < 0) continue;
        const text = new TextDecoder().decode(chunk.data.slice(n + 1));
        if (text.includes('preset') || text.includes('<param')) return stripBom(text);
      } else if (chunk.type === 'zTXt') {
        const n = chunk.data.indexOf(0);
        if (n < 0) continue;
        const inflated = pako.inflate(chunk.data.slice(n + 2));
        const text = new TextDecoder().decode(inflated);
        if (text.includes('preset') || text.includes('<param')) return stripBom(text);
      } else if (chunk.type === 'iTXt') {
        const n = chunk.data.indexOf(0);
        if (n < 0) continue;
        const flag = chunk.data[n + 1];
        let pos = n + 3;
        const langEnd = chunk.data.indexOf(0, pos);
        if (langEnd < 0) continue;
        pos = langEnd + 1;
        const transEnd = chunk.data.indexOf(0, pos);
        if (transEnd < 0) continue;
        pos = transEnd + 1;
        let text;
        if (flag === 1) {
          text = new TextDecoder().decode(pako.inflate(chunk.data.slice(pos)));
        } else {
          text = new TextDecoder().decode(chunk.data.slice(pos));
        }
        if (text.includes('preset') || text.includes('<param')) return stripBom(text);
      }
    } catch (e) { /* skip bad chunk */ }
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
    for (const k of keys) if (params[k] != null && !isNaN(parseFloat(params[k]))) return parseFloat(params[k]);
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
    img.onerror = () => reject(new Error('Failed to decode PNG'));
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
  return { tip, width, height };
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
  const buffer = await file.arrayBuffer();
  const chunks = parsePngChunks(buffer);
  const xml = extractXml(chunks);

  let settings = { name: file.name.replace(/\.kpp$/i, ''), size: null, spacing: null };
  if (xml) {
    try {
      const parsed = parseXmlSettings(xml);
      if (parsed.name) settings.name = parsed.name;
      if (parsed.size != null) settings.size = parsed.size;
      if (parsed.spacing != null) settings.spacing = parsed.spacing;
    } catch (e) { console.warn('XML parse failed:', e); }
  }

  const img = await loadPngAsImage(buffer);
  const { tip, width, height } = imageToTipData(img);
  const square = padToSquare(tip, width, height);
  const { tip: finalTip, size: finalSize } = downsample(square.tip, square.size, 2500);

  let spacingPct = 25;
  if (settings.spacing != null && !isNaN(settings.spacing)) {
    spacingPct = settings.spacing < 10
      ? Math.round(settings.spacing * 100)
      : Math.round(settings.spacing);
  }
  spacingPct = Math.max(1, Math.min(1000, spacingPct));

  return {
    name: settings.name || file.name.replace(/\.kpp$/i, ''),
    width: finalSize,
    height: finalSize,
    tipData: finalTip,
    spacing: spacingPct,
    thumbnail: makeThumbnail(img),
    sourceFile: file.name,
  };
}

// ---------- ABR writer (v2, sampled brush) ----------

function buildAbr(brushes) {
  const encoder = new TextEncoder();

  const prepared = brushes.map((brush) => {
    const clean = (brush.name || 'Brush').replace(/[\x00-\x1F\x7F]/g, '').substring(0, 255);
    const bytes = encoder.encode(clean);
    const len = bytes.length;
    const pad = (4 - ((len + 1) % 4)) % 4;
    return { brush, nameBytes: bytes, nameLen: len, namePad: pad };
  });

  let total = 2 + 2 + 4;
  for (const p of prepared) {
    total += 4 + 4 + 4;                  // type, size, spacing
    total += 1 + p.nameLen + p.namePad;  // pascal name
    total += 4;                          // antialiasing
    total += 4 + 4 + 4 + 4;              // top, left, bottom, right
    total += 4;                          // depth (bits per pixel)
    total += 1;                          // compression
    total += p.brush.tipData.length;     // tip bytes
  }

  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let o = 0;

  view.setUint16(o, 2, false); o += 2;           // version
  view.setUint16(o, 2, false); o += 2;           // subversion
  view.setUint32(o, prepared.length, false); o += 4;

  for (const p of prepared) {
    const b = p.brush;
    view.setUint32(o, 2, false); o += 4;         // sampled brush
    view.setUint32(o, b.width, false); o += 4;   // size
    view.setUint32(o, b.spacing, false); o += 4; // spacing (percent)

    view.setUint8(o, p.nameLen); o += 1;
    bytes.set(p.nameBytes, o); o += p.nameLen;
    o += p.namePad;

    view.setUint32(o, 1, false); o += 4;         // antialiasing

    view.setInt32(o, 0, false); o += 4;          // top
    view.setInt32(o, 0, false); o += 4;          // left
    view.setInt32(o, b.height, false); o += 4;   // bottom (exclusive)
    view.setInt32(o, b.width, false); o += 4;    // right  (exclusive)

    view.setUint32(o, 8, false); o += 4;         // depth = 8 bits/pixel
    view.setUint8(o, 0); o += 1;                 // compression = raw

    bytes.set(b.tipData, o); o += b.tipData.length;
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
  if (!valid.length) { setStatus('No .kpp files found in selection.', true); return; }

  setStatus(`Processing ${valid.length} file(s)...`);
  state.brushes = [];

  for (const file of valid) {
    try {
      const brush = await processKppFile(file);
      state.brushes.push({ ...brush, error: null });
    } catch (err) {
      state.brushes.push({ sourceFile: file.name, name: file.name, error: err.message });
    }
  }

  renderBrushes();
  const ok = state.brushes.filter(b => !b.error).length;
  setStatus(`Processed ${ok} of ${valid.length} file(s).`, ok === 0);
  if (ok > 0) outputSection.classList.remove('hidden');
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
  if (!valid.length) return;
  try {
    const blob = buildAbr(valid);
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
    setStatus('Download started.');
  } catch (err) {
    setStatus('Failed to build ABR: ' + err.message, true);
  }
});
