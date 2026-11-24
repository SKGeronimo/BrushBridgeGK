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
