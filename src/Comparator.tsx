import { useState, useMemo, useCallback } from 'react';
import { Chart as ChartJS, LogarithmicScale, Filler, ScatterController } from 'chart.js';
import { Scatter } from 'react-chartjs-2';
import { MusicalNoteIcon } from '@heroicons/react/24/outline';

ChartJS.register(LogarithmicScale, Filler, ScatterController);

type RolloffSlope = 0 | -1.5 | -3 | -4.5 | -6 | -7.5 | -9;

const ROLLOFF_OPTIONS: { label: string; value: RolloffSlope }[] = [
  { label: 'Flat', value: 0 },
  { label: '-1.5', value: -1.5 },
  { label: '-3 (pink)', value: -3 },
  { label: '-4.5', value: -4.5 },
  { label: '-6 (brown)', value: -6 },
  { label: '-7.5', value: -7.5 },
  { label: '-9', value: -9 },
];

const TRACK_COLORS = [
  { border: '#ffffff', bg: 'rgba(255,255,255,0.05)' },
  { border: 'rgba(255, 180, 50, 0.9)', bg: 'rgba(255,180,50,0.05)' },
];

interface TrackData {
  fileName: string;
  frequencies: number[];
  magnitudes: number[];
  lufs: number;
  truePeakDb: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function cooleyTukeyFFT(re: Float64Array, im: Float64Array) {
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
}

function createKWeightingFilters(ctx: OfflineAudioContext) {
  const highShelf = ctx.createBiquadFilter();
  highShelf.type = 'highshelf';
  highShelf.frequency.value = 1681.974450955533;
  highShelf.gain.value = 3.999843853973347;
  highShelf.Q.value = 0.7071752369554196;
  const highPass = ctx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = 38.13547087602444;
  highPass.Q.value = 0.5003270373238773;
  return { highShelf, highPass };
}

function computeIntegratedLUFS(channelData: Float32Array[], sampleRate: number): number {
  const blockSize = Math.round(0.4 * sampleRate);
  const stepSize = Math.round(0.1 * sampleRate);
  const numSamples = channelData[0].length;
  const channelWeights = channelData.length <= 2 ? new Array(channelData.length).fill(1.0) : [1.0, 1.0, 1.0, 1.41, 1.41];
  const powers: number[] = [];

  for (let start = 0; start + blockSize <= numSamples; start += stepSize) {
    let sumPower = 0;
    for (let ch = 0; ch < channelData.length; ch++) {
      const w = channelWeights[ch] || 1.0;
      let p = 0;
      for (let i = start; i < start + blockSize; i++) p += channelData[ch][i] * channelData[ch][i];
      sumPower += w * (p / blockSize);
    }
    if (sumPower > 0) powers.push(sumPower);
  }
  if (powers.length === 0) return -Infinity;

  const absGate = Math.pow(10, (-70 + 0.691) / 10);
  const afterAbs = powers.filter(p => p > absGate);
  if (afterAbs.length === 0) return -Infinity;

  const ungated = afterAbs.reduce((a, b) => a + b, 0) / afterAbs.length;
  const relGate = ungated * 0.1;
  const afterRel = afterAbs.filter(p => p > relGate);
  if (afterRel.length === 0) return -Infinity;

  return -0.691 + 10 * Math.log10(afterRel.reduce((a, b) => a + b, 0) / afterRel.length);
}

function computeTruePeak(channelData: Float32Array[]): number {
  let max = 0;
  for (const ch of channelData) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > max) max = a; }
  return max === 0 ? -Infinity : 20 * Math.log10(max);
}

function downsampleLog(frequencies: number[], magnitudes: number[], targetPoints: number): { frequencies: number[]; magnitudes: number[] } {
  if (frequencies.length <= targetPoints) return { frequencies, magnitudes };
  const logMin = Math.log10(frequencies[0]);
  const logMax = Math.log10(frequencies[frequencies.length - 1]);
  const step = (logMax - logMin) / (targetPoints - 1);
  const outF: number[] = [], outM: number[] = [];
  let idx = 0;
  for (let i = 0; i < targetPoints; i++) {
    const target = Math.pow(10, logMin + i * step);
    while (idx < frequencies.length - 1 && Math.abs(frequencies[idx + 1] - target) < Math.abs(frequencies[idx] - target)) idx++;
    outF.push(frequencies[idx]);
    outM.push(magnitudes[idx]);
  }
  return { frequencies: outF, magnitudes: outM };
}

async function analyzeFile(file: File, onStatus: (msg: string) => void): Promise<TrackData> {
  onStatus('Decoding...');
  const buf = await file.arrayBuffer();
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(buf);
  await ctx.close();

  // True peak
  onStatus('Computing true peak...');
  const overCtx = new OfflineAudioContext(decoded.numberOfChannels, decoded.length * 4, decoded.sampleRate * 4);
  const overSrc = overCtx.createBufferSource();
  overSrc.buffer = decoded;
  overSrc.connect(overCtx.destination);
  overSrc.start(0);
  const os = await overCtx.startRendering();
  const osCh: Float32Array[] = [];
  for (let ch = 0; ch < os.numberOfChannels; ch++) osCh.push(os.getChannelData(ch));
  const truePeakDb = computeTruePeak(osCh);

  // LUFS
  onStatus('Computing LUFS...');
  const kCtx = new OfflineAudioContext(decoded.numberOfChannels, decoded.length, decoded.sampleRate);
  const kSrc = kCtx.createBufferSource();
  kSrc.buffer = decoded;
  const { highShelf, highPass } = createKWeightingFilters(kCtx);
  kSrc.connect(highShelf);
  highShelf.connect(highPass);
  highPass.connect(kCtx.destination);
  kSrc.start(0);
  const kw = await kCtx.startRendering();
  const kCh: Float32Array[] = [];
  for (let ch = 0; ch < kw.numberOfChannels; ch++) kCh.push(kw.getChannelData(ch));
  const lufs = computeIntegratedLUFS(kCh, kw.sampleRate);

  // Spectrum
  onStatus('Computing spectrum...');
  const fftSize = 8192;
  const halfFFT = fftSize / 2;
  const totalSamples = decoded.length;
  let mono: Float32Array;
  if (decoded.numberOfChannels > 1) {
    const l = decoded.getChannelData(0), r = decoded.getChannelData(1);
    mono = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) mono[i] = (l[i] + r[i]) / 2;
  } else {
    mono = decoded.getChannelData(0);
  }

  const hopSize = fftSize / 2;
  const numFrames = Math.floor((mono.length - fftSize) / hopSize) + 1;
  const avgMag = new Float64Array(halfFFT);
  const hann = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));

  let processed = 0;
  const maxFrames = 1500;
  const frameStep = numFrames > maxFrames ? Math.floor(numFrames / maxFrames) : 1;
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);

  for (let f = 0; f < numFrames; f += frameStep) {
    const offset = f * hopSize;
    for (let i = 0; i < fftSize; i++) { re[i] = mono[offset + i] * hann[i]; im[i] = 0; }
    cooleyTukeyFFT(re, im);
    for (let i = 0; i < halfFFT; i++) avgMag[i] += re[i] * re[i] + im[i] * im[i];
    processed++;
    if (processed % 200 === 0) await new Promise(r => setTimeout(r, 0));
  }

  const frequencies: number[] = [], magnitudes: number[] = [];
  const binWidth = decoded.sampleRate / fftSize;
  for (let i = 1; i < halfFFT; i++) {
    const freq = i * binWidth;
    if (freq < 20 || freq > 20000) continue;
    frequencies.push(freq);
    magnitudes.push(10 * Math.log10(Math.max(avgMag[i] / processed, 1e-30)));
  }

  // 1/6 octave smoothing
  const smoothed: number[] = [];
  for (let i = 0; i < magnitudes.length; i++) {
    const freq = frequencies[i];
    const lo = freq * Math.pow(2, -1 / 12), hi = freq * Math.pow(2, 1 / 12);
    let sum = 0, count = 0;
    for (let j = 0; j < magnitudes.length; j++) {
      if (frequencies[j] >= lo && frequencies[j] <= hi) { sum += magnitudes[j]; count++; }
    }
    smoothed.push(count > 0 ? sum / count : magnitudes[i]);
  }

  return { fileName: file.name, frequencies, magnitudes: smoothed, lufs, truePeakDb };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Comparator() {
  const [trackA, setTrackA] = useState<{ file: File; data: TrackData | null }>({ file: null as any, data: null });
  const [trackB, setTrackB] = useState<{ file: File; data: TrackData | null }>({ file: null as any, data: null });
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [activeSlope, setActiveSlope] = useState<RolloffSlope>(-3);

  const handleFileA = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) setTrackA({ file: e.target.files[0], data: null });
  };
  const handleFileB = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) setTrackB({ file: e.target.files[0], data: null });
  };

  const handleCompare = useCallback(async () => {
    if (!trackA.file || !trackB.file) return;
    setIsProcessing(true);
    setStatusText('Analyzing Track A...');

    try {
      const dataA = await analyzeFile(trackA.file, msg => setStatusText(`Track A: ${msg}`));
      setTrackA(prev => ({ ...prev, data: dataA }));

      setStatusText('Analyzing Track B...');
      const dataB = await analyzeFile(trackB.file, msg => setStatusText(`Track B: ${msg}`));
      setTrackB(prev => ({ ...prev, data: dataB }));

      setStatusText('Done!');
      setIsProcessing(false);
    } catch (err) {
      setStatusText(`Error: ${(err as Error).message}`);
      setIsProcessing(false);
    }
  }, [trackA.file, trackB.file]);

  const chartData = useMemo(() => {
    const datasets: any[] = [];
    const refFreq = 1000;

    [trackA.data, trackB.data].forEach((d, idx) => {
      if (!d) return;
      const tilted = d.magnitudes.map((db, i) => db - activeSlope * Math.log2(d.frequencies[i] / refFreq));
      const ds = downsampleLog(d.frequencies, tilted, 600);
      datasets.push({
        label: d.fileName,
        data: ds.frequencies.map((f, i) => ({ x: f, y: ds.magnitudes[i] })),
        borderColor: TRACK_COLORS[idx].border,
        backgroundColor: TRACK_COLORS[idx].bg,
        borderWidth: 1.5,
        borderDash: idx === 1 ? [5, 3] : undefined,
        pointRadius: 0,
        pointHoverRadius: 3,
        fill: true,
        showLine: true,
        tension: 0.3,
      });
    });

    return { datasets };
  }, [trackA.data, trackB.data, activeSlope]);

  const chartOptions = useMemo(() => {
    const allY: number[] = [];
    const refFreq = 1000;
    [trackA.data, trackB.data].forEach(d => {
      if (d) d.magnitudes.forEach((db, i) => allY.push(db - activeSlope * Math.log2(d.frequencies[i] / refFreq)));
    });
    if (allY.length === 0) return {};
    const mn = Math.min(...allY), mx = Math.max(...allY);
    const pad = Math.max((mx - mn) * 0.1, 3);

    return {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      interaction: { mode: 'nearest' as const, intersect: false, axis: 'x' as const },
      plugins: {
        legend: { display: true, labels: { color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 12 }, boxWidth: 20, padding: 15 } },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.85)', padding: 10, cornerRadius: 4,
          titleFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
          bodyFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
          callbacks: {
            title: (items: any[]) => { if (!items.length) return ''; const f = items[0].parsed.x; return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(0)} Hz`; },
            label: (item: any) => `${item.dataset.label}: ${item.parsed.y.toFixed(1)} dB`,
          },
        },
      },
      scales: {
        x: {
          type: 'logarithmic' as const, min: 20, max: 20000,
          grid: { color: 'rgba(255,255,255,0.06)' }, border: { display: false },
          ticks: {
            color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 12, weight: 400 as const },
            callback: (v: number) => { const a = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]; return a.includes(v) ? (v >= 1000 ? `${v / 1000}k` : `${v}`) : ''; },
            autoSkip: false, maxRotation: 0,
          },
          title: { display: true, text: 'Frequency (Hz)', color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 12, weight: 500 as const } },
        },
        y: {
          min: Math.floor(mn - pad), max: Math.ceil(mx + pad),
          grid: { color: 'rgba(255,255,255,0.06)' }, border: { display: false },
          ticks: { color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 12, weight: 400 as const } },
          title: { display: true, text: 'Magnitude (dB)', color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 12, weight: 500 as const } },
        },
      },
    };
  }, [trackA.data, trackB.data, activeSlope]);

  const hasBoth = trackA.data && trackB.data;
  const lufsDiff = hasBoth ? Math.abs(trackA.data!.lufs - trackB.data!.lufs) : 0;

  const statBoxStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '8px', padding: '1.2rem 1rem',
  };

  return (
    <div style={{ marginTop: '1rem' }}>
      <div className="glass-panel">
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {/* Track A */}
          <div className="file-input-wrapper" style={{ flex: '1 1 200px' }}>
            <button className="button-primary" style={{ background: 'rgba(255,255,255,0.1)', boxShadow: 'none', maxWidth: '100%' }}>
              <MusicalNoteIcon width={20} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {trackA.file ? trackA.file.name : 'Track A'}
              </span>
            </button>
            <input type="file" accept="audio/*,.flac,.wav,.mp3" onChange={handleFileA} />
          </div>

          {/* Track B */}
          <div className="file-input-wrapper" style={{ flex: '1 1 200px' }}>
            <button className="button-primary" style={{ background: 'rgba(255,180,50,0.08)', borderColor: 'rgba(255,180,50,0.25)', boxShadow: 'none', maxWidth: '100%' }}>
              <MusicalNoteIcon width={20} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {trackB.file ? trackB.file.name : 'Track B'}
              </span>
            </button>
            <input type="file" accept="audio/*,.flac,.wav,.mp3" onChange={handleFileB} />
          </div>

          <button className="button-primary" onClick={handleCompare} disabled={!trackA.file || !trackB.file || isProcessing} style={{ flex: '0 0 auto' }}>
            {isProcessing ? 'Analyzing...' : 'Compare'}
          </button>
        </div>

        {isProcessing && (
          <div style={{ marginTop: '1rem' }}>
            <div className="status-text">{statusText}</div>
          </div>
        )}
      </div>

      {hasBoth && (
        <>
          {/* Stats comparison */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginTop: '2rem' }}>
            <div style={statBoxStyle}>
              <div className="stat-title" style={{ color: '#ffffff' }}>{trackA.data!.fileName}</div>
              <div style={{ display: 'flex', gap: '2rem', marginTop: '0.75rem' }}>
                <div>
                  <div className="stat-title">LUFS</div>
                  <div className="stat-value" style={{ fontSize: '1.8rem' }}>{trackA.data!.lufs.toFixed(1)}</div>
                </div>
                <div>
                  <div className="stat-title">True Peak</div>
                  <div className="stat-value" style={{ fontSize: '1.8rem', color: trackA.data!.truePeakDb > -1 ? '#ff6b6b' : 'var(--text-primary)' }}>
                    {trackA.data!.truePeakDb.toFixed(1)} <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>dBTP</span>
                  </div>
                </div>
              </div>
            </div>
            <div style={statBoxStyle}>
              <div className="stat-title" style={{ color: 'rgba(255,180,50,0.9)' }}>{trackB.data!.fileName}</div>
              <div style={{ display: 'flex', gap: '2rem', marginTop: '0.75rem' }}>
                <div>
                  <div className="stat-title">LUFS</div>
                  <div className="stat-value" style={{ fontSize: '1.8rem' }}>{trackB.data!.lufs.toFixed(1)}</div>
                </div>
                <div>
                  <div className="stat-title">True Peak</div>
                  <div className="stat-value" style={{ fontSize: '1.8rem', color: trackB.data!.truePeakDb > -1 ? '#ff6b6b' : 'var(--text-primary)' }}>
                    {trackB.data!.truePeakDb.toFixed(1)} <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>dBTP</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* LUFS difference callout */}
          <div style={{ marginTop: '1rem', padding: '0.6rem 1rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '6px', fontSize: '0.85rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
            LUFS difference: <strong style={{ color: 'var(--text-primary)' }}>{lufsDiff.toFixed(1)} LU</strong>
            {lufsDiff > 1 && <span> — consider loudness-matching for a fair spectral comparison</span>}
          </div>

          {/* Tilt controls */}
          <div style={{ marginTop: '1.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>Tilt:</span>
            {ROLLOFF_OPTIONS.map(opt => (
              <button key={opt.value} onClick={() => setActiveSlope(opt.value)} style={{
                background: activeSlope === opt.value ? 'rgba(255,255,255,0.1)' : 'transparent',
                border: `1px solid ${activeSlope === opt.value ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)'}`,
                color: activeSlope === opt.value ? 'var(--text-primary)' : 'var(--text-secondary)',
                padding: '0.3rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', cursor: 'pointer',
                transition: 'all 0.15s', fontFamily: 'Inter, system-ui, sans-serif',
                fontWeight: activeSlope === opt.value ? 600 : 400,
              }}>{opt.label}</button>
            ))}
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>dB/oct</span>
          </div>

          {/* Overlaid spectrum */}
          <div style={{ marginTop: '1rem' }}>
            <div className="chart-container" style={{ height: '420px' }}>
              <Scatter data={chartData} options={chartOptions as any} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
