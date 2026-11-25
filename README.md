# KPP → ABR Converter

Browser-only tool to convert Krita brush presets (`.kpp`) into Adobe ABR brush files, for use in Adobe Fresco, Photoshop, etc.

## How it works

1. A `.kpp` file is a PNG with brush settings in a hidden `zTXt`/`iTXt`/`tEXt` chunk.
2. This tool reads the PNG, extracts the XML, extracts the brush tip image, then writes a Photoshop ABR v2 (sampled brush) file.
3. Everything runs in your browser — no uploads.

## Limitations

- **ABR v2 is simple.** Krita dynamics (pressure curves, jitter, textures, dual brush, etc.) are not preserved. Only tip shape, size, spacing, and name carry over.
- If Fresco/Photoshop rejects the output, upgrade `buildAbr()` to emit ABR v6 (descriptor-based — significantly more complex).
- Tips are capped at 2500px (Photoshop's max).

## Local dev

Open `index.html` in a browser. No build step.

## Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main