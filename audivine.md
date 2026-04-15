# Audivine — Complete Reconstruction Specification

> **Audio Intelligence in the Browser** — A client-side audio analysis toolkit.
> Originally called "Tempo Plotter" (BPM detection only). Expanded on 2026-03-24 into the full 6-tab audio analysis suite.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Tech Stack & Dependencies](#tech-stack--dependencies)
3. [Project Structure](#project-structure)
4. [Build & Dev Configuration](#build--dev-configuration)
5. [Design System & CSS Variables](#design-system--css-variables)
6. [Tab 1 — BPM Analyzer (App.tsx)](#tab-1--bpm-analyzer-apptsx)
7. [Tab 2 — Tap Tempo (App.tsx)](#tab-2--tap-tempo-apptsx)
8. [Tab 3 — Spectrum Analyzer (SpectrumAnalyzer.tsx)](#tab-3--spectrum-analyzer-spectrumanalyzertsx)
9. [Tab 4 — Transient Density (TransientDensity.tsx)](#tab-4--transient-density-transientdensitytsx)
10. [Tab 5 — Key Detection (KeyDetection.tsx)](#tab-5--key-detection-keydetectiontsx)
11. [Tab 6 — Compare (Comparator.tsx)](#tab-6--compare-comparatortsx)
12. [Design Notes & User Feedback](#design-notes--user-feedback)
13. [Complete Source Code](#complete-source-code)

---

## Project Overview

**Audivine** is a single-page web application that performs professional-grade audio analysis entirely in the browser. No backend — all processing is client-side using the Web Audio API, Essentia.js (WASM), and a manual Cooley-Tukey FFT implementation.

### Key Architecture Decisions
- **Single-page app**, all processing client-side, no server needed
- **React 19 + TypeScript + Vite 7** as the application framework
- **Chart.js** (via `react-chartjs-2`) for all visualizations
- **Essentia.js WASM** for BPM/rhythm extraction (RhythmExtractor2013)
- **Manual Cooley-Tukey FFT** (no AnalyserNode) for cross-browser reliability
- **Web Audio API** for decoding, oversampling, K-weighting filters
- **Scatter chart type** used for log-frequency spectrum plots (`{x, y}` data)
- **Dark theme** with cyan accent color (`#00f0ff`), Inter font family

### Six Tabs
1. **BPM Analyzer** — Essentia RhythmExtractor2013, tempo flow chart, advanced smoothing pipeline
2. **Tap Tempo** — Manual tap BPM with keyboard support, auto-reset after 3s
3. **Spectrum** — Average frequency response with spectral tilt, plus sub-views (Waveform, Dynamics, Stereo Field)
4. **Transients** — Onset detection, density over time, RMS energy envelope
5. **Key** — Musical key detection with chromagram visualization, Camelot/Open Key notation
6. **Compare** — Two-file A/B spectrum + loudness comparison

> **User Feedback**: The comparator was explicitly requested to be its own tab, NOT inside the spectrum tab.

---

## Tech Stack & Dependencies

### package.json
```json
{
  "name": "tempo_plotter",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "vite preview"
  },
  "dependencies": {
    "@heroicons/react": "^2.2.0",
    "chart.js": "^4.5.1",
    "chartjs-plugin-annotation": "^3.1.0",
    "essentia.js": "^0.1.3",
    "music-metadata": "^11.12.1",
    "music-metadata-browser": "^2.5.11",
    "music-tempo": "^1.0.3",
    "node-wav": "^0.0.2",
    "react": "^19.2.0",
    "react-chartjs-2": "^5.3.1",
    "react-dom": "^19.2.0",
    "realtime-bpm-analyzer": "^5.0.1",
    "web-audio-beat-detector": "^8.2.35"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.1",
    "@types/node": "^24.10.1",
    "@types/react": "^19.2.7",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.1",
    "eslint": "^9.39.1",
    "eslint-plugin-react-hooks": "^7.0.1",
    "eslint-plugin-react-refresh": "^0.4.24",
    "globals": "^16.5.0",
    "typescript": "~5.9.3",
    "typescript-eslint": "^8.48.0",
    "vite": "^7.3.1"
  }
}
```

### Key Libraries
| Library | Purpose |
|---------|---------|
| `essentia.js` ^0.1.3 | WASM-based audio ML (RhythmExtractor2013 for BPM) |
| `chart.js` ^4.5.1 | All visualizations (Line, Scatter, Bar charts) |
| `react-chartjs-2` ^5.3.1 | React wrapper for Chart.js |
| `chartjs-plugin-annotation` ^3.1.0 | Time signature markers on BPM chart |
| `music-metadata-browser` ^2.5.11 | ID3 tag parsing (title, artist) |
| `@heroicons/react` ^2.2.0 | Icons for tabs and UI elements |

---

## Project Structure

```
src/
├── App.tsx              — Main app shell, tab routing, BPM Analyzer + Tap Tempo
├── SpectrumAnalyzer.tsx — Spectrum tab with sub-views (Spectrum, Waveform, Dynamics, Stereo)
├── TransientDensity.tsx — Transient density tab (onset detection via spectral flux)
├── KeyDetection.tsx     — Key detection (chromagram + Krumhansl-Schmuckler)
├── Comparator.tsx       — Compare tab (two-file spectrum overlay)
├── index.css            — All styles (dark theme, CSS variables)
├── main.tsx             — React entry point
index.html               — HTML shell
vite.config.ts           — Vite configuration
```

---

## Build & Dev Configuration

### index.html
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Audivine</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### Vite Config Notes
- Standard `@vitejs/plugin-react` setup
- Essentia.js (WebAssembly) may require COOP/COEP headers for SharedArrayBuffer. If needed, add to vite config:
  ```ts
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
  ```

---

## Design System & CSS Variables

The app uses a dark theme with glassmorphism-inspired panels. Key CSS classes referenced in the JSX:

### CSS Variables (inferred from code)
```css
:root {
  --accent-color: #00f0ff;      /* Cyan accent, used throughout */
  --text-primary: #ffffff;       /* White text */
  --text-secondary: #9aa8ba;    /* Muted grey-blue */
  --bg-primary: /* dark background, ~#0a0a14 or similar */;
}
```

### Key CSS Classes Used
- `.app-container` — Root wrapper
- `.header` — Top header with title, subtitle, and tab bar
- `.glass-panel` — Frosted glass card panels (backdrop-filter, rgba backgrounds)
- `.dashboard-grid` — Grid layout for settings + chart panels
- `.controls-row` — Flex row for controls
- `.control-group` — Label + input group
- `.file-input-wrapper` — Styled file input (button overlay)
- `.button-primary` — Accent-colored buttons with glow effect
- `.progress-container` / `.progress-bar` — Animated progress bar
- `.status-text` — Status message below progress bar
- `.summary-stats` — Grid of stat cards
- `.stat-card` — Individual stat card
- `.stat-title` — Small uppercase label
- `.stat-value` — Large number display
- `.stat-subtext` — Small descriptive text
- `.chart-container` — Chart wrapper with consistent height
- `.bpm-limits` — Flex row for min/max BPM inputs
- `.control-value` — Inline value display (e.g., "5s")
- `.panel-title` — Section heading with icon

### Fonts
- **Inter** from Google Fonts (or system-ui fallback): `'Inter, system-ui, sans-serif'`
- Used consistently across all Chart.js tooltip/tick/title configurations

### Chart Styling Conventions
All Chart.js instances share:
- `backgroundColor: 'rgba(0,0,0,0.85)'` for tooltips
- `grid.color: 'rgba(255,255,255,0.06)'` for chart grid lines
- `ticks.color: '#9aa8ba'` for axis labels
- `font.family: 'Inter, system-ui, sans-serif'`
- `border: { display: false }` on all axes
- `animation: { duration: 300 }` (except waveform which uses 0)

---

## Tab 1 — BPM Analyzer (App.tsx)

### UI Elements
- **File input** with music note icon, shows filename when selected
- **Smoothing Window** slider (0.5s – 20s, step 0.5, default 5)
- **Min/Max BPM** number inputs (default 60/200)
- **Detect Time Signatures** checkbox (experimental)
- **Advanced BPM Engine** collapsible section with:
  - IQR Outlier Rejection toggle (default ON)
  - Octave Locking toggle (default ON)
  - Tempo Continuity Constraint toggle (default ON)
  - Onset Cross-Validation toggle (default ON)
  - Weighted Median Smoothing toggle (default ON)
  - Outlier Strictness slider (1–3, step 0.1, default 1.5)
  - Max BPM Jump slider (2–20%, step 1, default 8%)
- **Analyze BPM** button
- **Progress bar** with status text during processing
- **Track Information** section (ID3 title + artist, or filename)
- **BPM Flow chart** (Chart.js Line chart, white line on dark background)
- **Summary stats**: Essentia Global, Median Tempo, Average Tempo, Min BPM, Max BPM
- **Ko-fi donation button** in header

### Processing Pipeline

1. **Read file** → `file.arrayBuffer()`
2. **Decode audio** → `AudioContext.decodeAudioData()`
3. **Resample to 44.1kHz** → `OfflineAudioContext` if needed (Essentia requires 44100)
4. **Initialize Essentia WASM** (singleton, cached on `window.essentiaInstance`)
   - Handles both function-factory and module export patterns
5. **Downmix to mono** → `(left + right) / 2`
6. **Onset cross-validation** (if enabled):
   - Compute spectral flux (half-wave rectified magnitude difference)
   - Autocorrelation to find periodicity
   - Perceptual weighting toward 120 BPM
7. **RhythmExtractor2013** → global BPM, confidence, tick positions
8. **Cross-validate** global BPM against onset estimate (detect doubling/halving)
9. **Calculate instantaneous BPM** from consecutive beat intervals
10. **Octave Locking** (if enabled): histogram-based dominant tempo detection, lock all values to nearest octave
11. **IQR Outlier Rejection** (if enabled): fence = Q1/Q3 ± strictness × IQR
12. **Tempo Continuity Constraint** (if enabled): clamp sudden jumps to max allowed percentage
13. **Smoothing**: weighted median (time-decay weighting) or simple moving average
14. **Calculate stats**: mean, median from cleaned data
15. **Time signature heuristic** (if enabled): energy-based 4/4 vs 3/4 detection using beat accents

### Key Formulas

**Spectral tilt**: `displayed_dB = measured_dB - slope × log2(freq / 1000)`

**Onset BPM**: `60 / (bestLag × hopSize / sampleRate)`

**Perceptual weighting**: `exp(-0.5 × ((bpmAtLag - 120) / 60)²)`

---

## Tab 2 — Tap Tempo (App.tsx)

### UI Elements
- Large "TAP IT" button (cyan glow)
- Reset Session button
- Average BPM (rounded whole number, 4.5rem font, accent color)
- Precise BPM (2 decimal places, 2.5rem font)
- Taps Recorded counter

### Logic
- **Keyboard support**: any key (except Escape/Tab) triggers tap when on this tab
- **Auto-reset**: 3 seconds of inactivity clears the session
- **BPM calculation**: `(taps.length - 1) / (elapsed_ms / 60000)`
- Spacebar preventDefault to avoid page scroll

---

## Tab 3 — Spectrum Analyzer (SpectrumAnalyzer.tsx)

### Overview
The most complex component. Contains its own file upload + analysis pipeline, plus 4 sub-views.

### Sub-Views
1. **Spectrum** — Average frequency response (20Hz–20kHz), log scale X axis
2. **Waveform** — Peak envelope + RMS overlay (2000 segments)
3. **Dynamics** — Short-term LUFS over time (3s blocks, 1s hop)
4. **Stereo Field** — Lissajous plot, correlation over time, M/S metrics

### Stat Cards (always shown)
| Stat | Description | Warning Threshold |
|------|-------------|-------------------|
| Integrated LUFS | ITU-R BS.1770 | — |
| True Peak | 4x oversampled | Red if > -1 dBTP |
| Crest Factor | Peak-to-RMS ratio | — |
| LRA | Loudness Range (EBU R128) | — |
| PLR | Peak-to-Loudness Ratio | — |
| Correlation | Stereo (only if stereo) | Red < 0, Yellow < 0.3 |
| M/S Balance | Mid/Side ratio (only if stereo) | — |

### Analysis Pipeline

1. **Decode audio** → standard AudioContext
2. **True Peak**: 4x oversample via OfflineAudioContext, find max absolute value
3. **K-Weighting for LUFS**:
   - High shelf: f=1681.97Hz, gain=+4dB, Q=0.707
   - High pass: f=38.14Hz, Q=0.500
   - Applied via OfflineAudioContext biquad filters
4. **Integrated LUFS** (ITU-R BS.1770):
   - 400ms blocks, 100ms hop
   - Absolute gate at -70 LUFS
   - Relative gate at mean - 10dB
5. **Short-term LUFS**: 3s blocks, 1s hop
6. **LRA**: 10th to 95th percentile range after -20dB relative gate
7. **Crest Factor**: 20 × log10(peak / rms)
8. **Waveform**: 2000-segment peak/RMS envelope, clipping detection (|sample| >= 0.9999)
9. **Stereo correlation**: Pearson over entire file, plus 100ms windowed timeline
10. **Lissajous**: ~4000 subsampled L/R points
11. **Mid/Side ratio**: 10 × log10(midPower / sidePower)
12. **FFT Spectrum**:
    - Manual Cooley-Tukey radix-2 FFT, size 8192
    - Hann window
    - Max 2000 frames, proportional stepping for long files
    - 1/6 octave smoothing
    - Downsample to 600 points for chart (log-spaced)

### Spectral Tilt Options
| Slope | Color | Description |
|-------|-------|-------------|
| 0 dB/oct | White (#ffffff) | Flat |
| -1.5 dB/oct | Green (rgba(100,255,100,0.8)) | |
| -3 dB/oct | Cyan (rgba(0,240,255,0.8)) | Pink noise compensation (DEFAULT) |
| -4.5 dB/oct | Purple (rgba(180,100,255,0.8)) | |
| -6 dB/oct | Red (rgba(255,100,100,0.8)) | Brown noise |
| -7.5 dB/oct | Pink (rgba(255,150,200,0.8)) | |
| -9 dB/oct | Yellow (rgba(255,200,50,0.8)) | |

**Critical Design Decision**: The tilt **modifies the actual spectrum curve** (like SPAN's slope knob), NOT drawn as separate reference lines. Formula: `displayed_dB = measured_dB - slope × log2(freq / 1000)` with refFreq = 1 kHz.

### Cooley-Tukey FFT Implementation
```typescript
function cooleyTukeyFFT(re: Float64Array, im: Float64Array) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterfly operations
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const tRe = curRe * re[i + j + halfLen] - curIm * im[i + j + halfLen];
        const tIm = curRe * im[i + j + halfLen] + curIm * re[i + j + halfLen];
        re[i + j + halfLen] = re[i + j] - tRe;
        im[i + j + halfLen] = im[i + j] - tIm;
        re[i + j] += tRe;
        im[i + j] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}
```

### K-Weighting Filter Coefficients (ITU-R BS.1770)
```typescript
// High shelf
highShelf.frequency.value = 1681.974450955533;
highShelf.gain.value = 3.999843853973347;
highShelf.Q.value = 0.7071752369554196;

// High pass
highPass.frequency.value = 38.13547087602444;
highPass.Q.value = 0.5003270373238773;
```

---

## Tab 4 — Transient Density (TransientDensity.tsx)

### UI Elements
- File upload + "Analyze Transients" button
- Stats: Total Onsets, Avg Density (/sec), Peak Density (/sec + timestamp), Duration
- Transient Density Over Time chart (Line, cyan)
- RMS Energy Envelope chart (Line, orange/amber)

### Analysis Pipeline
1. Decode + downmix to mono
2. Compute RMS energy per frame (frameSize=1024, hop=512)
3. Onset detection: positive energy differences exceeding `1.5 × local_average` with 50ms minimum gap
4. Density: onsets/second in 2s sliding window, 0.5s hop
5. Energy envelope: 500-point downsample of frame energies

---

## Tab 5 — Key Detection (KeyDetection.tsx)

### UI Elements
- File upload + "Detect Key" button
- Main result: Detected Key + Mode (4rem accent color)
- Confidence percentage
- Camelot and Open Key notation
- Top 6 matches with correlation bars
- Chromagram bar chart (12 pitch classes)

### Analysis Pipeline
1. Decode + downmix to mono
2. Compute chromagram:
   - FFT size 8192, hop 4096
   - Map bins to pitch classes (C2–C7 range, MIDI note calculation)
   - Sum energy per pitch class across all frames
3. Normalize chroma to [0, 1]
4. Correlate with all 24 key profiles (Krumhansl-Schmuckler):
   - **Major**: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
   - **Minor**: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
5. Best correlation = detected key

### Camelot Wheel Mapping
```
Major: B=1B, F#=2B, C#=3B, G#=4B, D#=5B, A#=6B, F=7B, C=8B, G=9B, D=10B, A=11B, E=12B
Minor: G#=1A, D#=2A, A#=3A, F=4A, C=5A, G=6A, D=7A, A=8A, E=9A, B=10A, F#=11A, C#=12A
```

---

## Tab 6 — Compare (Comparator.tsx)

### UI Elements
- Two file inputs (Track A = white, Track B = amber/orange)
- "Compare" button
- Stats panels for each track: LUFS, True Peak (red if > -1 dBTP)
- LUFS difference callout with loudness-matching suggestion if > 1 LU
- Tilt control buttons (same options as Spectrum tab but compact)
- Overlaid spectrum chart (Track A = solid white, Track B = dashed amber)

### Analysis Pipeline
Per track:
1. Decode audio
2. True peak (4x oversample)
3. K-weighted LUFS
4. FFT spectrum (same as SpectrumAnalyzer but with 1500 max frames)
5. 1/6 octave smoothing

### Track Colors
- Track A: border `#ffffff`, background `rgba(255,255,255,0.05)`
- Track B: border `rgba(255, 180, 50, 0.9)`, background `rgba(255,180,50,0.05)`, dashed line

---

## Design Notes & User Feedback

### User Background
The user has deep knowledge of audio engineering and mastering workflows:
- Spectral tilt / dB per octave slopes (pink noise = -3dB/oct, brown = -6dB/oct)
- LUFS metering (ITU-R BS.1770), true peak, LRA, crest factor
- Stereo field analysis (correlation, mid/side, Lissajous)
- Musical key detection (Camelot, Open Key notation)
- Thinks in terms of mastering tools (e.g., SPAN's slope parameter)

### Critical Feedback Applied
1. **Spectral tilt slopes must be applied to the spectrum curve itself**, not as separate overlay lines. Like SPAN's slope knob — selecting -3 dB/oct compensates the measured spectrum so that pink noise appears flat.
2. **Comparator must be its own tab**, not nested inside the Spectrum tab.

### Header Elements
- Title: "Audivine"
- Subtitle: "Audio Intelligence in the Browser"
- Ko-fi donation link (placeholder URL: `https://ko-fi.com/YOUR_USERNAME`)
- Tab bar with Heroicons: ChartBarIcon, CursorArrowRaysIcon, SignalIcon, BoltIcon, KeyIcon, ArrowsRightLeftIcon

### Essentia.js WASM Loading Pattern
The WASM module loading handles multiple initialization patterns:
```typescript
if (typeof EssentiaWASM === 'function') {
  const mod = await EssentiaWASM();
  instance = new Essentia(mod);
} else if (EssentiaWASM.EssentiaJS) {
  instance = new Essentia(EssentiaWASM);
} else {
  // Wait for onRuntimeInitialized callback with timeout fallback
}
```

---

## Complete Source Code

All source code below was recovered from Claude's file-history snapshots (latest versions).

---

### `src/App.tsx` (1009 lines)

The main application component. Contains the BPM Analyzer and Tap Tempo tabs, plus the tab routing for all 6 tabs.

**Imports:**
```typescript
import { useState, useEffect, useCallback } from 'react';
// @ts-expect-error - essentia.js lacks TS bindings
import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js';
// @ts-expect-error
import Essentia from 'essentia.js/dist/essentia.js-core.es.js';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend } from 'chart.js';
import { Line } from 'react-chartjs-2';
import annotationPlugin from 'chartjs-plugin-annotation';
import { Cog6ToothIcon, MusicalNoteIcon, CursorArrowRaysIcon, ArrowPathIcon, ChartBarIcon, SignalIcon, BoltIcon, KeyIcon, ArrowsRightLeftIcon } from '@heroicons/react/24/outline';
import SpectrumAnalyzer from './SpectrumAnalyzer';
import TransientDensity from './TransientDensity';
import KeyDetection from './KeyDetection';
import Comparator from './Comparator';
import * as mm from 'music-metadata-browser';
```

**State variables:**
- `file`, `isProcessing`, `progress`, `statusText`
- `smoothingWindow` (5), `minBpm` (60), `maxBpm` (200), `enableTimeSig` (false)
- `showAdvanced` (false), plus 5 algorithm toggles and 2 numeric params
- `bpmData`, `globalBpm`, `medianBpm`, `meanBpm`
- `activeTab` ('analyzer' | 'taptempo' | 'spectrum' | 'transients' | 'key' | 'compare')
- `timeSigs`, `songMeta`
- `taps` (for tap tempo)

**Chart config:** White line, `tension: 0.5`, transparent points, annotation plugin for time signature markers.

> **Note**: The full 1009-line source code is preserved in Claude's file-history at:
> `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/a54b07dd9ca6c003@v6`

---

### `src/SpectrumAnalyzer.tsx` (1037 lines)

The most complex component. Contains:
- Manual Cooley-Tukey FFT
- K-weighting filters
- LUFS computation (integrated + short-term)
- True peak (4x oversampled)
- Stereo analysis (correlation, Lissajous, M/S)
- Waveform envelope
- LRA, PLR, Crest factor
- 4 sub-view tabs with memoized chart data

**Types:**
```typescript
type RolloffSlope = 0 | -1.5 | -3 | -4.5 | -6 | -7.5 | -9;
type SubView = 'spectrum' | 'waveform' | 'dynamics' | 'stereo';

interface AnalysisData {
  frequencies: number[];
  magnitudes: number[];
  lufs: number;
  truePeakDb: number;
  isStereo: boolean;
  sampleRate: number;
  duration: number;
  shortTermLufs: { time: number; lufs: number }[];
  crestFactorDb: number;
  lra: number;
  plr: number;
  overallCorrelation: number;
  correlationOverTime: { time: number; correlation: number }[];
  lissajousL: number[];
  lissajousR: number[];
  midSideRatioDb: number;
  waveform: { time: number; min: number; max: number; rms: number }[];
  clippingCount: number;
}
```

> **Source**: `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/dea44abd5a3ee280@v6`

---

### `src/TransientDensity.tsx` (309 lines)

Onset detection using energy-based spectral flux with adaptive thresholding.

> **Source**: `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/060b3ad9b3c53308@v2`

---

### `src/KeyDetection.tsx` (370 lines)

Chromagram computation via FFT + Krumhansl-Schmuckler key profile correlation.

> **Source**: `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/c17087449d11988e@v2`

---

### `src/Comparator.tsx` (446 lines)

Two-file A/B comparison with overlaid spectra and LUFS/True Peak metrics.

> **Source**: `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/57bd3d9d0e0fbbda@v2`

---

## Reconstruction Steps

1. **Create project**: `npx -y create-vite@latest ./ --template react-ts`
2. **Install dependencies**: `npm install @heroicons/react chart.js chartjs-plugin-annotation essentia.js music-metadata music-metadata-browser music-tempo node-wav react-chartjs-2 realtime-bpm-analyzer web-audio-beat-detector`
3. **Copy source files** from the file-history paths listed above into `src/`
4. **Create/update `src/index.css`** with the dark theme styles (CSS variables, glass panels, etc.)
5. **Verify WASM loading** — may need COOP/COEP headers in `vite.config.ts`
6. **Run**: `npm run dev`

### File-History Recovery Paths
The complete source code for each file is preserved in Claude's file-history:

| File | Path |
|------|------|
| App.tsx (v6) | `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/a54b07dd9ca6c003@v6` |
| SpectrumAnalyzer.tsx (v6) | `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/dea44abd5a3ee280@v6` |
| TransientDensity.tsx (v2) | `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/060b3ad9b3c53308@v2` |
| KeyDetection.tsx (v2) | `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/c17087449d11988e@v2` |
| Comparator.tsx (v2) | `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/57bd3d9d0e0fbbda@v2` |
| index.html (v2) | `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/2a7e1abf5c0bb00d@v2` |
| README.md (v2) | `~/.claude/file-history/1674c2b6-e614-4f8f-bff2-64832eb4617c/7e0275e1d0bb610d@v2` |

### Missing File: `src/index.css`
The CSS file was **not found** in the file-history snapshots. It will need to be reconstructed based on the class names referenced throughout the JSX code. Key requirements:
- Dark background (~#0a0a14 or similar very dark blue-black)
- `.glass-panel` with backdrop-filter blur, rgba border, rounded corners
- `.button-primary` with accent color glow
- `.progress-bar` with cyan gradient
- `.summary-stats` as CSS grid
- Inter font import from Google Fonts
- Responsive layout, mobile-friendly

### Related Conversation Sessions
- `1674c2b6-e614-4f8f-bff2-64832eb4617c` — Main development session (spectrum, transients, key, comparator, advanced BPM)
- `2c7406cf-dbc2-4441-89c4-621adeefdc88` — WASM debugging session (Essentia loading issues)
- `0fdcae07-530c-4532-825c-d7ace3de3582` — Initial BPM detector + time signatures
- `722e39e1-0942-4f5a-800f-1a24fdc86fe0` — Tap tempo feature
- `b3a5e184-2730-412c-9625-e9bc44d3393c` — CSS classnames explainer

---

*Document generated on 2026-04-15 from Claude/Gemini conversation log forensics and file-history snapshot recovery.*
