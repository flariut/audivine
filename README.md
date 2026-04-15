# Audivine

Audio Intelligence in the Browser — a client-side audio analysis toolkit.

## Tech Stack

- React 19 + TypeScript + Vite 7
- Chart.js (react-chartjs-2) for all visualizations
- Essentia.js (WASM) for BPM/rhythm extraction
- Web Audio API for decoding, FFT, K-weighting, oversampling
- music-metadata-browser for ID3 tag parsing

## Architecture

Single-page app, all processing client-side. No backend.

- `src/App.tsx` — Main app shell, tab routing, BPM Analyzer + Tap Tempo tabs
- `src/SpectrumAnalyzer.tsx` — Spectrum tab with sub-views: Spectrum, Waveform, Dynamics, Stereo Field. Contains manual Cooley-Tukey FFT, LUFS (ITU-R BS.1770), true peak (4x oversampled), stereo correlation, Lissajous, LRA, crest factor
- `src/TransientDensity.tsx` — Transient density tab (onset detection via spectral flux)
- `src/KeyDetection.tsx` — Key detection tab (chromagram + Krumhansl-Schmuckler profiles, Camelot/Open Key)
- `src/Comparator.tsx` — Compare tab (two-file spectrum overlay with shared tilt + LUFS/TP comparison)
- `src/index.css` — All styles (dark theme, CSS variables)

## Tabs

1. **BPM Analyzer** — Essentia RhythmExtractor2013, tempo flow chart, smoothing, time signature detection
2. **Tap Tempo** — Manual tap BPM, keyboard support, auto-reset
3. **Spectrum** — Avg frequency response with spectral tilt (-1.5 to -9 dB/oct), waveform, dynamics (short-term LUFS, LRA), stereo field (Lissajous, correlation)
4. **Transients** — Onset detection, density over time, RMS energy envelope
5. **Key** — Musical key detection with chromagram visualization
6. **Compare** — Two-file A/B spectrum + loudness comparison

## Key Patterns

- Spectrum tilt applies correction to the measured spectrum curve (e.g., -3 dB/oct makes pink noise flat). Reference at 1 kHz.
- FFT is manual Cooley-Tukey radix-2 (no AnalyserNode dependency) for reliability across browsers
- LUFS uses OfflineAudioContext for K-weighting (biquad filters), then gated block measurement
- All charts use Chart.js with consistent dark styling (Inter font, rgba grid lines, accent color #00f0ff)
- Scatter chart type used for log-frequency spectrum plots ({x, y} data)

## Commands

- `npm run dev` — Start dev server (Vite)
- `npm run build` — Type-check + production build
- `npm run lint` — ESLint
