// ---------- ABR writer (v2, correct legacy layout) ----------
// Layout per brush record (all big-endian):
//   u16 type (2 = sampled)
//   u32 length (size of the rest of this brush record)
//   u32 misc
//   u16 spacing (%)
//   u16 diameter
//   u16 roundness (%)
//   i16 angle
//   u16 hardness (%)
//   [if v2] u32 nameCharCount (including null) + UTF-16BE chars + null
//   i32 bounds top, left, bottom, right
//   u16 depth (bits per pixel, 8)
//   u16 compression (0 = raw)
//   width*height bytes of tip data

function buildAbr(brushes) {
  const encoder = new TextEncoder();

  const prepared = brushes.map(brush => {
    // Sanitize name and encode as UTF-16BE
    const cleanName = (brush.name || 'Brush').replace(/[\x00-\x1F\x7F]/g, '').substring(0, 255);
    const nameChars = cleanName.length;
    const nameBytes = new Uint8Array((nameChars + 1) * 2); // +1 for null terminator
    const nameView = new DataView(nameBytes.buffer);
    for (let i = 0; i < nameChars; i++) {
      nameView.setUint16(i * 2, cleanName.charCodeAt(i), false); // big-endian
    }
    nameView.setUint16(nameChars * 2, 0, false); // null terminator

    // Build the brush record body (everything after the initial u16 type)
    const body = new ArrayBuffer(64 + nameBytes.length); // generous estimate
    const bv = new DataView(body);
    let bo = 0;

    bv.setUint32(bo, 0, false); bo += 4;         // misc
    bv.setUint16(bo, brush.spacing, false); bo += 2; // spacing
    bv.setUint16(bo, brush.width, false); bo += 2;   // diameter
    bv.setUint16(bo, 100, false); bo += 2;       // roundness = 100%
    bv.setInt16(bo, 0, false); bo += 2;          // angle = 0
    bv.setUint16(bo, 100, false); bo += 2;       // hardness = 100%

    // Name (v2: u32 char count + UTF-16BE + null)
    bv.setUint32(bo, nameChars + 1, false); bo += 4; // char count incl. null
    new Uint8Array(body, bo, nameBytes.length).set(nameBytes); bo += nameBytes.length;

    // Bounds
    bv.setInt32(bo, 0, false); bo += 4;             // top
    bv.setInt32(bo, 0, false); bo += 4;             // left
    bv.setInt32(bo, brush.height, false); bo += 4;  // bottom
    bv.setInt32(bo, brush.width, false); bo += 4;   // right

    // Depth and compression
    bv.setUint16(bo, 8, false); bo += 2;            // depth = 8 bpp
    bv.setUint16(bo, 0, false); bo += 2;            // compression = raw

    // Tip data
    new Uint8Array(body, bo).set(brush.tipData);
    bo += brush.tipData.length;

    // Slice the body to the actual size
    const actualBody = body.slice(0, bo);

    // Now build the full brush record: u16 type + u32 length + body
    const record = new ArrayBuffer(2 + 4 + actualBody.byteLength);
    const rv = new DataView(record);
    rv.setUint16(0, 2, false); // type = sampled
    rv.setUint32(2, actualBody.byteLength, false); // length of body
    new Uint8Array(record, 6).set(new Uint8Array(actualBody));

    return { record, name: cleanName };
  });

  // Calculate total file size
  let total = 4; // header: version (u16) + count (u16)
  for (const p of prepared) {
    total += p.record.byteLength;
  }

  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let o = 0;

  // Header: version = 2, count = number of brushes
  view.setUint16(o, 2, false); o += 2; // version
  view.setUint16(o, prepared.length, false); o += 2; // count

  // Write each brush record
  for (const p of prepared) {
    bytes.set(new Uint8Array(p.record), o);
    o += p.record.byteLength;
  }

  console.log(`[ABR] Built v2 file: ${total} bytes for ${prepared.length} brush(es)`);
  return new Blob([buffer], { type: 'application/octet-stream' });
}