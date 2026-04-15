import { useState, useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, BarElement, BarController } from 'chart.js';
import { MusicalNoteIcon } from '@heroicons/react/24/outline';

ChartJS.register(BarElement, BarController);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Krumhansl-Schmuckler key profiles
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

function rotateArray(arr: number[], shift: number): number[] {
  const n = arr.length;
  const s = ((shift % n) + n) % n;
  return [...arr.slice(s), ...arr.slice(0, s)];
}

interface KeyResult {
  key: string;
  mode: 'Major' | 'Minor';
  confidence: number;
  chroma: number[];
  allCorrelations: { key: string; mode: string; correlation: number }[];
}

export default function KeyDetection() {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [result, setResult] = useState<KeyResult | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) setFile(e.target.files[0]);
  };

  const handleAnalyze = async () => {
    if (!file) return;
    setIsProcessing(true);
    setProgress(0);
    setStatusText('Reading file...');
    setResult(null);

    try {
      const buf = await file.arrayBuffer();
      setProgress(5);
      setStatusText('Decoding audio...');

      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const decoded = await ctx.decodeAudioData(buf);
      await ctx.close();

      setProgress(15);
      setStatusText('Downmixing to mono...');
      await new Promise(r => setTimeout(r, 20));

      const sampleRate = decoded.sampleRate;
      const totalSamples = decoded.length;
      let mono: Float32Array;
      if (decoded.numberOfChannels > 1) {
        const l = decoded.getChannelData(0);
        const r = decoded.getChannelData(1);
        mono = new Float32Array(totalSamples);
        for (let i = 0; i < totalSamples; i++) mono[i] = (l[i] + r[i]) / 2;
      } else {
        mono = decoded.getChannelData(0);
      }

      setProgress(25);
      setStatusText('Computing chromagram...');
      await new Promise(r => setTimeout(r, 20));

      // Compute chromagram using constant-Q-like approach
      // For each of the 12 pitch classes, sum energy at all octaves of that note
      const chroma = new Float64Array(12);
      const fftSize = 8192;
      const hopSize = 4096;
      const numFrames = Math.floor((totalSamples - fftSize) / hopSize) + 1;

      // Hann window
      const hann = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));

      // FFT
      const fft = (re: Float64Array, im: Float64Array) => {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
          let bit = n >> 1;
          for (; j & bit; bit >>= 1) j ^= bit;
          j ^= bit;
          if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
        }
        for (let len = 2; len <= n; len <<= 1) {
          const halfLen = len >> 1;
          const angle = -2 * Math.PI / len;
          const wRe = Math.cos(angle), wIm = Math.sin(angle);
          for (let i = 0; i < n; i += len) {
            let cRe = 1, cIm = 0;
            for (let j = 0; j < halfLen; j++) {
              const tRe = cRe * re[i + j + halfLen] - cIm * im[i + j + halfLen];
              const tIm = cRe * im[i + j + halfLen] + cIm * re[i + j + halfLen];
              re[i + j + halfLen] = re[i + j] - tRe;
              im[i + j + halfLen] = im[i + j] - tIm;
              re[i + j] += tRe;
              im[i + j] += tIm;
              const nRe = cRe * wRe - cIm * wIm;
              cIm = cRe * wIm + cIm * wRe;
              cRe = nRe;
            }
          }
        }
      };

      const re = new Float64Array(fftSize);
      const im = new Float64Array(fftSize);
      const binWidth = sampleRate / fftSize;

      // Pre-compute which FFT bin maps to which chroma note
      // A4 = 440 Hz, each semitone = 2^(1/12) apart
      // For each bin, find which pitch class it belongs to (if any musical note)
      const halfFFT = fftSize / 2;
      const binToChroma = new Int8Array(halfFFT);
      binToChroma.fill(-1);
      for (let i = 1; i < halfFFT; i++) {
        const freq = i * binWidth;
        if (freq < 65 || freq > 2100) continue; // C2 to C7 roughly
        // Which semitone is this frequency?
        const semitone = 12 * Math.log2(freq / 440) + 69; // MIDI note number
        const pitchClass = Math.round(semitone) % 12;
        // Only assign if the bin is close to a note (within 0.5 semitones)
        const fracSemitone = semitone - Math.round(semitone);
        if (Math.abs(fracSemitone) < 0.4) {
          binToChroma[i] = (pitchClass + 12) % 12;
        }
      }

      const maxFrames = 1000;
      const frameStep = numFrames > maxFrames ? Math.floor(numFrames / maxFrames) : 1;
      let framesProcessed = 0;

      for (let f = 0; f < numFrames; f += frameStep) {
        const offset = f * hopSize;
        for (let i = 0; i < fftSize; i++) { re[i] = mono[offset + i] * hann[i]; im[i] = 0; }
        fft(re, im);

        for (let i = 1; i < halfFFT; i++) {
          const pc = binToChroma[i];
          if (pc >= 0) {
            chroma[pc] += re[i] * re[i] + im[i] * im[i];
          }
        }
        framesProcessed++;
        if (framesProcessed % 50 === 0) {
          setProgress(25 + Math.round((framesProcessed / Math.ceil(numFrames / frameStep)) * 60));
          await new Promise(r => setTimeout(r, 0));
        }
      }

      setProgress(90);
      setStatusText('Matching key profiles...');
      await new Promise(r => setTimeout(r, 20));

      // Normalize chroma
      const chromaArr = Array.from(chroma);
      const chromaMax = Math.max(...chromaArr);
      const normalizedChroma = chromaArr.map(v => chromaMax > 0 ? v / chromaMax : 0);

      // Correlate with all 24 key profiles
      const allCorrelations: { key: string; mode: 'Major' | 'Minor'; correlation: number }[] = [];

      for (let shift = 0; shift < 12; shift++) {
        const majorCorr = correlate(normalizedChroma, rotateArray(MAJOR_PROFILE, shift));
        const minorCorr = correlate(normalizedChroma, rotateArray(MINOR_PROFILE, shift));
        allCorrelations.push({ key: NOTE_NAMES[shift], mode: 'Major', correlation: majorCorr });
        allCorrelations.push({ key: NOTE_NAMES[shift], mode: 'Minor', correlation: minorCorr });
      }

      // Sort by correlation
      allCorrelations.sort((a, b) => b.correlation - a.correlation);
      const best = allCorrelations[0];
      const secondBest = allCorrelations[1];
      const _confidence = best.correlation - secondBest.correlation;

      setResult({
        key: best.key,
        mode: best.mode,
        confidence: Math.min(best.correlation, 1),
        chroma: normalizedChroma,
        allCorrelations,
      });

      setProgress(100);
      setStatusText('Analysis complete!');
      setIsProcessing(false);
    } catch (err) {
      console.error('Key detection error:', err);
      setStatusText(`Error: ${(err as Error).message}`);
      setIsProcessing(false);
    }
  };

  // Chroma bar chart
  const chromaChartData = useMemo(() => {
    if (!result) return null;
    return {
      labels: NOTE_NAMES,
      datasets: [{
        label: 'Chroma Energy',
        data: result.chroma,
        backgroundColor: NOTE_NAMES.map((_, i) => {
          const detectedIdx = NOTE_NAMES.indexOf(result.key);
          return i === detectedIdx ? 'rgba(0, 240, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)';
        }),
        borderColor: NOTE_NAMES.map((_, i) => {
          const detectedIdx = NOTE_NAMES.indexOf(result.key);
          return i === detectedIdx ? 'rgba(0, 240, 255, 0.9)' : 'rgba(255, 255, 255, 0.3)';
        }),
        borderWidth: 1,
        borderRadius: 4,
      }],
    };
  }, [result]);

  const chromaOptions = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(0,0,0,0.85)', padding: 10, cornerRadius: 4, displayColors: false,
        titleFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
        bodyFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
        callbacks: { label: (item: any) => `Energy: ${(item.parsed.y * 100).toFixed(1)}%` },
      },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 500 as const } } },
      y: {
        min: 0, max: 1.1,
        grid: { color: 'rgba(255,255,255,0.06)' }, border: { display: false },
        ticks: { display: false },
      },
    },
  };

  // Top key correlations
  const topCorrelations = useMemo(() => {
    if (!result) return [];
    return result.allCorrelations.slice(0, 6);
  }, [result]);

  const statBoxStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '8px',
    padding: '1.2rem 1rem',
  };

  return (
    <div style={{ marginTop: '1rem' }}>
      <div className="glass-panel">
        <div className="controls-row">
          <div className="file-input-wrapper">
            <button className="button-primary" style={{ background: 'rgba(255,255,255,0.1)', boxShadow: 'none', maxWidth: '100%' }}>
              <MusicalNoteIcon width={20} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {file ? file.name : 'Select Audio File'}
              </span>
            </button>
            <input type="file" accept="audio/*,.flac,.wav,.mp3" onChange={handleFileChange} />
          </div>
          <button className="button-primary" onClick={handleAnalyze} disabled={!file || isProcessing}>
            {isProcessing ? 'Processing...' : 'Detect Key'}
          </button>
        </div>
        {isProcessing && (
          <div style={{ marginTop: '1.5rem' }}>
            <div className="progress-container"><div className="progress-bar" style={{ width: `${progress}%` }}></div></div>
            <div className="status-text">{statusText}</div>
          </div>
        )}
      </div>

      {result && (
        <>
          {/* Main result */}
          <div style={{ display: 'flex', gap: '2rem', marginTop: '2rem', flexWrap: 'wrap' }}>
            <div style={{ ...statBoxStyle, flex: '1 1 250px', textAlign: 'center', padding: '2rem' }}>
              <div className="stat-title">Detected Key</div>
              <div className="stat-value" style={{ fontSize: '4rem', color: 'var(--accent-color)', marginTop: '0.5rem' }}>
                {result.key} <span style={{ fontSize: '2rem', color: 'var(--text-primary)' }}>{result.mode}</span>
              </div>
              <div className="stat-subtext" style={{ marginTop: '0.5rem' }}>
                Confidence: {(result.confidence * 100).toFixed(0)}%
              </div>
              <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Camelot: {getCamelotKey(result.key, result.mode)} | Open Key: {getOpenKey(result.key, result.mode)}
              </div>
            </div>

            {/* Top matches */}
            <div style={{ ...statBoxStyle, flex: '1 1 300px' }}>
              <div className="stat-title">Top Matches</div>
              <div style={{ marginTop: '0.75rem' }}>
                {topCorrelations.map((c, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '0.4rem 0', borderBottom: i < topCorrelations.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  }}>
                    <span style={{ color: i === 0 ? 'var(--accent-color)' : 'var(--text-secondary)', fontWeight: i === 0 ? 600 : 400, fontSize: '0.9rem' }}>
                      {c.key} {c.mode}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <div style={{ width: '80px', height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{ width: `${Math.max(0, c.correlation * 100)}%`, height: '100%', background: i === 0 ? 'var(--accent-color)' : 'rgba(255,255,255,0.3)', borderRadius: '2px' }}></div>
                      </div>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', minWidth: '40px', textAlign: 'right' }}>
                        {(c.correlation * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Chromagram */}
          <div style={{ marginTop: '2rem' }}>
            <h2 className="panel-title">Chromagram (Pitch Class Energy)</h2>
            <div className="chart-container" style={{ height: '250px' }}>
              {chromaChartData && <Bar data={chromaChartData} options={chromaOptions as any} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Camelot & Open Key helpers ─────────────────────────────────────────────

function getCamelotKey(note: string, mode: string): string {
  const majorMap: Record<string, string> = { 'B': '1B', 'F#': '2B', 'C#': '3B', 'G#': '4B', 'D#': '5B', 'A#': '6B', 'F': '7B', 'C': '8B', 'G': '9B', 'D': '10B', 'A': '11B', 'E': '12B' };
  const minorMap: Record<string, string> = { 'G#': '1A', 'D#': '2A', 'A#': '3A', 'F': '4A', 'C': '5A', 'G': '6A', 'D': '7A', 'A': '8A', 'E': '9A', 'B': '10A', 'F#': '11A', 'C#': '12A' };
  return mode === 'Major' ? (majorMap[note] || '?') : (minorMap[note] || '?');
}

function getOpenKey(note: string, mode: string): string {
  const majorMap: Record<string, string> = { 'C': '1d', 'C#': '2d', 'D': '3d', 'D#': '4d', 'E': '5d', 'F': '6d', 'F#': '7d', 'G': '8d', 'G#': '9d', 'A': '10d', 'A#': '11d', 'B': '12d' };
  const minorMap: Record<string, string> = { 'C': '1m', 'C#': '2m', 'D': '3m', 'D#': '4m', 'E': '5m', 'F': '6m', 'F#': '7m', 'G': '8m', 'G#': '9m', 'A': '10m', 'A#': '11m', 'B': '12m' };
  return mode === 'Major' ? (majorMap[note] || '?') : (minorMap[note] || '?');
}
