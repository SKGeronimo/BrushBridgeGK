# BrushBridge — KPP to ABR Converter

Free, experimental browser-based tool that attempts to extract bitmap brush tips from Krita `.kpp` presets and export sampled brushes in legacy Photoshop `.abr` version 1 format.

## Features

- Runs entirely in the browser; files are not uploaded.
- Drag-and-drop multiple `.kpp` presets.
- Attempts to find embedded PNG tip resources in KPP's PNG/XML metadata.
- Preview and fallback-to-preset-thumbnail when no tip is found.
- Exports a legacy ABR v1 file containing sampled bitmap tips.
- No paid APIs, account, or server required.

## Limitations / experimental status

This is an early proof of concept. Krita KPP presets are PNG files with brush engine XML metadata and embedded resources. Extraction is heuristic: the converter scans embedded metadata for PNG data, and may use the preset thumbnail as fallback. That fallback is not guaranteed to be the actual brush tip.

ABR v1 sampled-brush serialization is experimental. Compatibility has not been validated against Photoshop releases. The exporter currently uses uncompressed grayscale pixel data and supports bitmap tips only. Brush engine dynamics, textures, scatter, smudge, color, and other Krita-specific behaviors are not converted.

Please test the generated ABR in a disposable brush set before relying on it. Contributions and sample-file-based format validation are welcome.

## iPad / iPhone note

iOS and iPadOS do not know the `.kpp` file type, so the file picker intentionally has no type filter (otherwise `.kpp` files appear greyed out). Any file can be chosen; non-PNG data is reported as unreadable.

## Run

Open `index.html` in a modern browser. For best results use a local static server (optional), e.g.:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## Deploy to GitHub Pages

1. Create a GitHub repository and upload these files to its root.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select `main` and `/ (root)`, save.
5. Wait for the deployment, then open the published URL.

## License

MIT — see `LICENSE`.

## Output format

Writes a modern Photoshop brush library: ABR v10.2 by default (v10.1, v6.2 and v6.1 are selectable), with 8BIM `samp` (RLE-compressed 8-bit tips, 255 = ink), `patt` and `desc` sections, 4-byte aligned. Each tip gets a full sampled-brush preset (spacing, dynamics flags, brush size etc.) like Photoshop writes. Tips are read from the `.gbr` (or PNG/SVG) files Krita stores next to its presets; add them, or the `.bundle`, alongside the `.kpp` files. Krita's built-in round/square brushes are approximated with a generated tip.

Adobe Fresco imports ABR through Creative Cloud and is stricter than Photoshop. If it finds nothing, use **Download Fresco test files** to export five builds of your first brushes and see which one imports. If brushes import inverted, tick **Invert tip data**. Large sets import more reliably in small batches.

`core.js` has no DOM dependencies and can be tested in Node.
