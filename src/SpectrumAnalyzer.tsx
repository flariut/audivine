import { useState, useRef, useMemo, useCallback } from 'react';
import { Chart as ChartJS, LogarithmicScale, Filler, ScatterController } from 'chart.js';
import { Scatter, Line } from 'react-chartjs-2';
import { MusicalNoteIcon } from '@heroicons/react/24/outline';

ChartJS.register(LogarithmicScale, Filler, ScatterController);

// ─── Types ───────────────────────────────────────────────────────────────────

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

  // Dynamic range
  shortTermLufs: { time: number; lufs: number }[];
  crestFactorDb: number;
  lra: number;
  plr: number;

  // Stereo field
  overallCorrelation: number;
  correlationOverTime: { time: number; correlation: number }[];
  lissajousL: number[];
  lissajousR: number[];
  midSideRatioDb: number;

  // Waveform
  waveform: { time: number; min: number; max: number; rms: number }[];
  clippingCount: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ROLLOFF_OPTIONS: { label: string; value: RolloffSlope }[] = [
  { label: 'Flat (0 dB/oct)', value: 0 },
  { label: '-1.5 dB/oct', value: -1.5 },
  { label: '-3 dB/oct (pink)', value: -3 },
  { label: '-4.5 dB/oct', value: -4.5 },
  { label: '-6 dB/oct (brown)', value: -6 },
  { label: '-7.5 dB/oct', value: -7.5 },
  { label: '-9 dB/oct', value: -9 },
];

const ROLLOFF_COLORS: Record<RolloffSlope, string> = {
  0: '#ffffff',
  [-1.5]: 'rgba(100, 255, 100, 0.8)',
  [-3]: 'rgba(0, 240, 255, 0.8)',
  [-4.5]: 'rgba(180, 100, 255, 0.8)',
  [-6]: 'rgba(255, 100, 100, 0.8)',
  [-7.5]: 'rgba(255, 150, 200, 0.8)',
  [-9]: 'rgba(255, 200, 50, 0.8)',
};

const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: 'spectrum', label: 'Spectrum' },
  { key: 'waveform', label: 'Waveform' },
  { key: 'dynamics', label: 'Dynamics' },
  { key: 'stereo', label: 'Stereo Field' },
];

// ─── Helper Functions ────────────────────────────────────────────────────────

function cooleyTukeyFFT(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
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

function computeBlockLoudness(data: Float32Array[], sampleRate: number, blockSizeSec: number, hopSizeSec: number): { time: number; lufs: number }[] {
  const blockSize = Math.round(blockSizeSec * sampleRate);
  const hopSize = Math.round(hopSizeSec * sampleRate);
  const numSamples = data[0].length;
  const results: { time: number; lufs: number }[] = [];
  const channelWeights = data.length <= 2 ? new Array(data.length).fill(1.0) : [1.0, 1.0, 1.0, 1.41, 1.41];

  for (let start = 0; start + blockSize <= numSamples; start += hopSize) {
    let sumPower = 0;
    for (let ch = 0; ch < data.length; ch++) {
      const weight = channelWeights[ch] || 1.0;
      let power = 0;
      for (let i = start; i < start + blockSize; i++) {
        power += data[ch][i] * data[ch][i];
      }
      sumPower += weight * (power / blockSize);
    }
    const lufs = sumPower > 0 ? -0.691 + 10 * Math.log10(sumPower) : -Infinity;
    results.push({ time: (start + blockSize / 2) / sampleRate, lufs });
  }
  return results;
}

function computeIntegratedLUFS(channelData: Float32Array[], sampleRate: number): number {
  const blocks = computeBlockLoudness(channelData, sampleRate, 0.4, 0.1);
  const powers = blocks.map(b => b.lufs > -Infinity ? Math.pow(10, (b.lufs + 0.691) / 10) : 0).filter(p => p > 0);
  if (powers.length === 0) return -Infinity;

  const absoluteGate = Math.pow(10, (-70 + 0.691) / 10);
  const afterAbsolute = powers.filter(p => p > absoluteGate);
  if (afterAbsolute.length === 0) return -Infinity;

  const ungatedMean = afterAbsolute.reduce((a, b) => a + b, 0) / afterAbsolute.length;
  const relativeGate = ungatedMean * 0.1;
  const afterRelative = afterAbsolute.filter(p => p > relativeGate);
  if (afterRelative.length === 0) return -Infinity;

  const gatedMean = afterRelative.reduce((a, b) => a + b, 0) / afterRelative.length;
  return -0.691 + 10 * Math.log10(gatedMean);
}

function computeTruePeak(channelData: Float32Array[]): number {
  let maxAbs = 0;
  for (const ch of channelData) {
    for (let i = 0; i < ch.length; i++) {
      const abs = Math.abs(ch[i]);
      if (abs > maxAbs) maxAbs = abs;
    }
  }
  return maxAbs === 0 ? -Infinity : 20 * Math.log10(maxAbs);
}

function computeLRA(shortTermLufs: { time: number; lufs: number }[]): number {
  const valid = shortTermLufs.filter(s => s.lufs > -Infinity).map(s => s.lufs);
  if (valid.length < 2) return 0;

  // Absolute gate at -70 LUFS
  const afterAbsolute = valid.filter(l => l > -70);
  if (afterAbsolute.length < 2) return 0;

  // Relative gate: -20 dB below ungated mean (EBU R128 uses -20 for LRA)
  const powers = afterAbsolute.map(l => Math.pow(10, l / 10));
  const meanPower = powers.reduce((a, b) => a + b, 0) / powers.length;
  const relativeGateDb = 10 * Math.log10(meanPower) - 20;
  const afterRelative = afterAbsolute.filter(l => l > relativeGateDb).sort((a, b) => a - b);
  if (afterRelative.length < 2) return 0;

  const p10idx = Math.floor(afterRelative.length * 0.1);
  const p95idx = Math.floor(afterRelative.length * 0.95);
  return afterRelative[p95idx] - afterRelative[p10idx];
}

function downsampleLog(frequencies: number[], magnitudes: number[], targetPoints: number): { frequencies: number[]; magnitudes: number[] } {
  if (frequencies.length <= targetPoints) return { frequencies, magnitudes };
  const logMin = Math.log10(frequencies[0]);
  const logMax = Math.log10(frequencies[frequencies.length - 1]);
  const step = (logMax - logMin) / (targetPoints - 1);
  const outFreqs: number[] = [];
  const outMags: number[] = [];
  let srcIdx = 0;
  for (let i = 0; i < targetPoints; i++) {
    const targetFreq = Math.pow(10, logMin + i * step);
    while (srcIdx < frequencies.length - 1 && Math.abs(frequencies[srcIdx + 1] - targetFreq) < Math.abs(frequencies[srcIdx] - targetFreq)) srcIdx++;
    outFreqs.push(frequencies[srcIdx]);
    outMags.push(magnitudes[srcIdx]);
  }
  return { frequencies: outFreqs, magnitudes: outMags };
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Shared Analysis Logic ──────────────────────────────────────────────────

async function analyzeSpectrum(decoded: AudioBuffer, onProgress: (pct: number, msg: string) => void): Promise<{ frequencies: number[]; magnitudes: number[] }> {
  onProgress(50, 'Computing average frequency spectrum...');
  await new Promise(r => setTimeout(r, 20));

  const fftSize = 8192;
  const halfFFT = fftSize / 2;
  const totalSamples = decoded.length;
  let mono: Float32Array;
  if (decoded.numberOfChannels > 1) {
    const left = decoded.getChannelData(0);
    const right = decoded.getChannelData(1);
    mono = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) mono[i] = (left[i] + right[i]) / 2;
  } else {
    mono = decoded.getChannelData(0);
  }

  const hopSize = fftSize / 2;
  const numFrames = Math.floor((mono.length - fftSize) / hopSize) + 1;
  const avgMag = new Float64Array(halfFFT);
  const hannWindow = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));

  let framesProcessed = 0;
  const maxFrames = 2000;
  const frameStep = numFrames > maxFrames ? Math.floor(numFrames / maxFrames) : 1;
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (let frame = 0; frame < numFrames; frame += frameStep) {
    const offset = frame * hopSize;
    for (let i = 0; i < fftSize; i++) { re[i] = mono[offset + i] * hannWindow[i]; im[i] = 0; }
    cooleyTukeyFFT(re, im);
    for (let i = 0; i < halfFFT; i++) avgMag[i] += re[i] * re[i] + im[i] * im[i];
    framesProcessed++;
    if (framesProcessed % 100 === 0) {
      onProgress(50 + Math.round((framesProcessed / Math.ceil(numFrames / frameStep)) * 35), `Computing spectrum... (${Math.round(framesProcessed / Math.ceil(numFrames / frameStep) * 100)}%)`);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  const frequencies: number[] = [];
  const magnitudes: number[] = [];
  const binWidth = decoded.sampleRate / fftSize;
  for (let i = 1; i < halfFFT; i++) {
    const freq = i * binWidth;
    if (freq < 20 || freq > 20000) continue;
    frequencies.push(freq);
    magnitudes.push(10 * Math.log10(Math.max(avgMag[i] / framesProcessed, 1e-30)));
  }

  // 1/6 octave smoothing
  const smoothed: number[] = [];
  for (let i = 0; i < magnitudes.length; i++) {
    const freq = frequencies[i];
    const lo = freq * Math.pow(2, -1 / 12);
    const hi = freq * Math.pow(2, 1 / 12);
    let sum = 0, count = 0;
    for (let j = 0; j < magnitudes.length; j++) {
      if (frequencies[j] >= lo && frequencies[j] <= hi) { sum += magnitudes[j]; count++; }
    }
    smoothed.push(count > 0 ? sum / count : magnitudes[i]);
  }

  return { frequencies, magnitudes: smoothed };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function SpectrumAnalyzer() {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [data, setData] = useState<AnalysisData | null>(null);
  const [activeSlope, setActiveSlope] = useState<RolloffSlope>(-3);
  const [subView, setSubView] = useState<SubView>('spectrum');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) setFile(e.target.files[0]);
  };

  const updateProgress = useCallback((pct: number, msg: string) => {
    setProgress(pct);
    setStatusText(msg);
  }, []);

  const handleAnalyze = async () => {
    if (!file) return;
    setIsProcessing(true);
    setProgress(0);
    setStatusText('Reading file...');
    setData(null);

    try {
      const arrayBuffer = await file.arrayBuffer();
      updateProgress(5, 'Decoding audio...');
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      await audioCtx.close();
      const isStereo = decoded.numberOfChannels >= 2;
      const duration = decoded.duration;

      // ── True peak (4x oversample) ──
      updateProgress(10, 'Computing true peak (4x oversampled)...');
      await new Promise(r => setTimeout(r, 20));
      const overCtx = new OfflineAudioContext(decoded.numberOfChannels, decoded.length * 4, decoded.sampleRate * 4);
      const overSrc = overCtx.createBufferSource();
      overSrc.buffer = decoded;
      overSrc.connect(overCtx.destination);
      overSrc.start(0);
      const oversampled = await overCtx.startRendering();
      const osChannels: Float32Array[] = [];
      for (let ch = 0; ch < oversampled.numberOfChannels; ch++) osChannels.push(oversampled.getChannelData(ch));
      const truePeakDb = computeTruePeak(osChannels);

      // ── K-weighting + LUFS ──
      updateProgress(20, 'K-weighting for LUFS...');
      await new Promise(r => setTimeout(r, 20));
      const kCtx = new OfflineAudioContext(decoded.numberOfChannels, decoded.length, decoded.sampleRate);
      const kSrc = kCtx.createBufferSource();
      kSrc.buffer = decoded;
      const { highShelf, highPass } = createKWeightingFilters(kCtx);
      kSrc.connect(highShelf);
      highShelf.connect(highPass);
      highPass.connect(kCtx.destination);
      kSrc.start(0);
      const kWeighted = await kCtx.startRendering();
      const kChannels: Float32Array[] = [];
      for (let ch = 0; ch < kWeighted.numberOfChannels; ch++) kChannels.push(kWeighted.getChannelData(ch));
      const lufs = computeIntegratedLUFS(kChannels, kWeighted.sampleRate);

      // ── Short-term LUFS (3s blocks, 1s hop) ──
      updateProgress(30, 'Computing short-term loudness...');
      await new Promise(r => setTimeout(r, 20));
      const shortTermLufs = computeBlockLoudness(kChannels, kWeighted.sampleRate, 3, 1);
      const lra = computeLRA(shortTermLufs);
      const plr = truePeakDb - lufs;

      // ── Crest factor ──
      let peakAbs = 0, sumSq = 0, totalCount = 0;
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const d = decoded.getChannelData(ch);
        for (let i = 0; i < d.length; i++) {
          const abs = Math.abs(d[i]);
          if (abs > peakAbs) peakAbs = abs;
          sumSq += d[i] * d[i];
          totalCount++;
        }
      }
      const rmsLevel = Math.sqrt(sumSq / totalCount);
      const crestFactorDb = rmsLevel > 0 ? 20 * Math.log10(peakAbs / rmsLevel) : 0;

      // ── Waveform envelope ──
      updateProgress(35, 'Computing waveform...');
      await new Promise(r => setTimeout(r, 20));
      const waveformPoints = 2000;
      const mono = new Float32Array(decoded.length);
      if (isStereo) {
        const l = decoded.getChannelData(0), r = decoded.getChannelData(1);
        for (let i = 0; i < decoded.length; i++) mono[i] = (l[i] + r[i]) / 2;
      } else {
        mono.set(decoded.getChannelData(0));
      }
      const segSize = Math.floor(decoded.length / waveformPoints);
      const waveform: { time: number; min: number; max: number; rms: number }[] = [];
      let clippingCount = 0;
      for (let seg = 0; seg < waveformPoints; seg++) {
        const start = seg * segSize;
        const end = Math.min(start + segSize, decoded.length);
        let mn = Infinity, mx = -Infinity, sq = 0;
        for (let i = start; i < end; i++) {
          const v = mono[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          sq += v * v;
          if (Math.abs(v) >= 0.9999) clippingCount++;
        }
        waveform.push({
          time: ((start + end) / 2) / decoded.sampleRate,
          min: mn,
          max: mx,
          rms: Math.sqrt(sq / (end - start)),
        });
      }

      // ── Stereo field ──
      updateProgress(40, 'Analyzing stereo field...');
      await new Promise(r => setTimeout(r, 20));
      let overallCorrelation = 1;
      const correlationOverTime: { time: number; correlation: number }[] = [];
      let lissajousL: number[] = [];
      let lissajousR: number[] = [];
      let midSideRatioDb = 0;

      if (isStereo) {
        const left = decoded.getChannelData(0);
        const right = decoded.getChannelData(1);

        // Overall correlation
        let sumLR = 0, sumLL = 0, sumRR = 0;
        for (let i = 0; i < decoded.length; i++) {
          sumLR += left[i] * right[i];
          sumLL += left[i] * left[i];
          sumRR += right[i] * right[i];
        }
        const denom = Math.sqrt(sumLL * sumRR);
        overallCorrelation = denom > 0 ? sumLR / denom : 0;

        // Correlation over time (100ms windows)
        const corrWindowSize = Math.round(0.1 * decoded.sampleRate);
        const corrHop = Math.round(0.05 * decoded.sampleRate);
        for (let start = 0; start + corrWindowSize <= decoded.length; start += corrHop) {
          let lr = 0, ll = 0, rr = 0;
          for (let i = start; i < start + corrWindowSize; i++) {
            lr += left[i] * right[i];
            ll += left[i] * left[i];
            rr += right[i] * right[i];
          }
          const d = Math.sqrt(ll * rr);
          correlationOverTime.push({
            time: (start + corrWindowSize / 2) / decoded.sampleRate,
            correlation: d > 0 ? lr / d : 0,
          });
        }

        // Lissajous subsample (~4000 points)
        const lissStep = Math.max(1, Math.floor(decoded.length / 4000));
        for (let i = 0; i < decoded.length; i += lissStep) {
          lissajousL.push(left[i]);
          lissajousR.push(right[i]);
        }

        // Mid/Side ratio
        let midPower = 0, sidePower = 0;
        for (let i = 0; i < decoded.length; i++) {
          const mid = (left[i] + right[i]) / 2;
          const side = (left[i] - right[i]) / 2;
          midPower += mid * mid;
          sidePower += side * side;
        }
        midPower /= decoded.length;
        sidePower /= decoded.length;
        midSideRatioDb = sidePower > 0 ? 10 * Math.log10(midPower / sidePower) : Infinity;
      }

      // ── Spectrum ──
      const spectrum = await analyzeSpectrum(decoded, updateProgress);

      setData({
        ...spectrum,
        lufs,
        truePeakDb,
        isStereo,
        sampleRate: decoded.sampleRate,
        duration,
        shortTermLufs,
        crestFactorDb,
        lra,
        plr,
        overallCorrelation,
        correlationOverTime,
        lissajousL,
        lissajousR,
        midSideRatioDb,
        waveform,
        clippingCount,
      });

      updateProgress(100, 'Analysis complete!');
      setIsProcessing(false);
    } catch (err) {
      console.error('Analysis error:', err);
      setStatusText(`Error: ${(err as Error).message}`);
      setIsProcessing(false);
    }
  };

  // ─── Chart Data Memos ─────────────────────────────────────────────────────

  // Spectrum chart
  const spectrumChartData = useMemo(() => {
    if (!data) return null;
    const refFreq = 1000;
    const tilted = data.magnitudes.map((db, i) => db - activeSlope * Math.log2(data.frequencies[i] / refFreq));
    const ds = downsampleLog(data.frequencies, tilted, 600);

    const datasets: any[] = [{
      label: 'Avg Frequency Response',
      data: ds.frequencies.map((f, i) => ({ x: f, y: ds.magnitudes[i] })),
      borderColor: ROLLOFF_COLORS[activeSlope],
      backgroundColor: `${ROLLOFF_COLORS[activeSlope]}08`,
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      fill: 'start',
      showLine: true,
      tension: 0.3,
    }];

    return { datasets };
  }, [data, activeSlope]);

  const spectrumChartOptions = useMemo(() => {
    if (!data) return {};
    const refFreq = 1000;
    const tilted = data.magnitudes.map((db, i) => db - activeSlope * Math.log2(data.frequencies[i] / refFreq));
    const minDb = Math.min(...tilted);
    const maxDb = Math.max(...tilted);
    const pad = Math.max((maxDb - minDb) * 0.1, 3);

    return {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      interaction: { mode: 'nearest' as const, intersect: false, axis: 'x' as const },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.85)', padding: 10, cornerRadius: 4, displayColors: false,
          maxWidth: 200,
          titleFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
          bodyFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
          filter: (_item: any, index: number) => index === 0,
          callbacks: {
            title: (items: any[]) => { if (!items.length) return ''; const f = items[0].parsed.x; return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(0)} Hz`; },
            label: (item: any) => `${item.parsed.y.toFixed(1)} dB`,
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
          min: Math.floor(minDb - pad), max: Math.ceil(maxDb + pad),
          grid: { color: 'rgba(255,255,255,0.06)' }, border: { display: false },
          ticks: { color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 12, weight: 400 as const } },
          title: { display: true, text: 'Magnitude (dB)', color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 12, weight: 500 as const } },
        },
      },
    };
  }, [data, activeSlope]);

  // Waveform chart
  const waveformChartData = useMemo(() => {
    if (!data) return null;
    const labels = data.waveform.map(w => formatTime(w.time));
    return {
      labels,
      datasets: [
        {
          label: 'Peak Max',
          data: data.waveform.map(w => w.max),
          borderColor: 'rgba(255,255,255,0.6)',
          backgroundColor: 'rgba(255,255,255,0.08)',
          borderWidth: 0.5,
          pointRadius: 0,
          fill: 'origin',
          tension: 0,
        },
        {
          label: 'Peak Min',
          data: data.waveform.map(w => w.min),
          borderColor: 'rgba(255,255,255,0.6)',
          backgroundColor: 'rgba(255,255,255,0.08)',
          borderWidth: 0.5,
          pointRadius: 0,
          fill: 'origin',
          tension: 0,
        },
        {
          label: 'RMS',
          data: data.waveform.map(w => w.rms),
          borderColor: 'rgba(0, 240, 255, 0.6)',
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
          tension: 0.1,
        },
        {
          label: '-RMS',
          data: data.waveform.map(w => -w.rms),
          borderColor: 'rgba(0, 240, 255, 0.6)',
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
          tension: 0.1,
        },
      ],
    };
  }, [data]);

  const waveformOptions = useMemo(() => ({
    responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(0,0,0,0.85)', padding: 10, cornerRadius: 4, displayColors: false,
        titleFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
        bodyFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
        callbacks: {
          label: (item: any) => {
            if (item.datasetIndex === 0) return `Peak: ${item.parsed.y.toFixed(3)}`;
            if (item.datasetIndex === 2) return `RMS: ${item.parsed.y.toFixed(3)}`;
            return '';
          },
          afterBody: () => data?.clippingCount ? [`Clips detected: ${data.clippingCount}`] : [],
        },
        filter: (item: any) => item.datasetIndex === 0 || item.datasetIndex === 2,
      },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: '#9aa8ba', maxTicksLimit: 15, font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: 400 as const } } },
      y: { min: -1.05, max: 1.05, grid: { color: 'rgba(255,255,255,0.06)' }, border: { display: false }, ticks: { color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: 400 as const } } },
    },
  }), [data]);

  // Dynamics chart (short-term LUFS over time)
  const dynamicsChartData = useMemo(() => {
    if (!data) return null;
    return {
      labels: data.shortTermLufs.map(s => formatTime(s.time)),
      datasets: [{
        label: 'Short-Term LUFS (3s)',
        data: data.shortTermLufs.map(s => s.lufs === -Infinity ? null : s.lufs),
        borderColor: 'rgba(0, 240, 255, 0.8)',
        backgroundColor: 'rgba(0, 240, 255, 0.05)',
        borderWidth: 1.2,
        pointRadius: 0,
        fill: true,
        tension: 0.3,
        spanGaps: true,
      }],
    };
  }, [data]);

  const dynamicsOptions = useMemo(() => {
    if (!data) return {};
    const valid = data.shortTermLufs.filter(s => s.lufs > -Infinity).map(s => s.lufs);
    const mn = valid.length > 0 ? Math.min(...valid) : -60;
    const mx = valid.length > 0 ? Math.max(...valid) : 0;
    const pad = Math.max((mx - mn) * 0.15, 3);
    return {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      interaction: { mode: 'index' as const, intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.85)', padding: 10, cornerRadius: 4, displayColors: false,
          titleFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
          bodyFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
          callbacks: { label: (item: any) => `${item.parsed.y?.toFixed(1) ?? '-inf'} LUFS` },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: '#9aa8ba', maxTicksLimit: 15, font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: 400 as const } } },
        y: {
          min: Math.floor(mn - pad), max: Math.ceil(mx + pad),
          grid: { color: 'rgba(255,255,255,0.06)' }, border: { display: false },
          ticks: { color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: 400 as const } },
          title: { display: true, text: 'LUFS', color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 12, weight: 500 as const } },
        },
      },
    };
  }, [data]);

  // Stereo correlation chart
  const correlationChartData = useMemo(() => {
    if (!data || !data.isStereo) return null;
    return {
      labels: data.correlationOverTime.map(c => formatTime(c.time)),
      datasets: [{
        label: 'Stereo Correlation',
        data: data.correlationOverTime.map(c => c.correlation),
        borderColor: (ctx: any) => {
          const v = ctx.raw;
          if (v === undefined) return 'rgba(0, 240, 255, 0.8)';
          if (v < 0) return 'rgba(255, 100, 100, 0.8)';
          if (v < 0.3) return 'rgba(255, 200, 50, 0.8)';
          return 'rgba(100, 255, 100, 0.8)';
        },
        segment: {
          borderColor: (ctx: any) => {
            const v = ctx.p1.parsed.y;
            if (v < 0) return 'rgba(255, 100, 100, 0.8)';
            if (v < 0.3) return 'rgba(255, 200, 50, 0.8)';
            return 'rgba(100, 255, 100, 0.8)';
          },
        },
        borderWidth: 1.2,
        pointRadius: 0,
        fill: false,
        tension: 0.2,
      }],
    };
  }, [data]);

  const correlationOptions = useMemo(() => ({
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(0,0,0,0.85)', padding: 10, cornerRadius: 4, displayColors: false,
        titleFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
        bodyFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
        callbacks: { label: (item: any) => `Correlation: ${item.parsed.y.toFixed(3)}` },
      },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: '#9aa8ba', maxTicksLimit: 15, font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: 400 as const } } },
      y: {
        min: -1, max: 1,
        grid: { color: 'rgba(255,255,255,0.06)' }, border: { display: false },
        ticks: { color: '#9aa8ba', stepSize: 0.5, font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: 400 as const } },
        title: { display: true, text: 'Correlation', color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 12, weight: 500 as const } },
      },
    },
  }), []);

  // Lissajous chart
  const lissajousChartData = useMemo(() => {
    if (!data || !data.isStereo || data.lissajousL.length === 0) return null;
    return {
      datasets: [{
        label: 'L/R',
        data: data.lissajousL.map((l, i) => ({ x: l, y: data.lissajousR[i] })),
        backgroundColor: 'rgba(0, 240, 255, 0.08)',
        borderColor: 'rgba(0, 240, 255, 0.15)',
        pointRadius: 1,
        pointHoverRadius: 2,
        showLine: false,
      }],
    };
  }, [data]);

  const lissajousOptions = useMemo(() => ({
    responsive: true, maintainAspectRatio: true, aspectRatio: 1, animation: { duration: 0 },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: {
        min: -1, max: 1,
        grid: { color: 'rgba(255,255,255,0.06)' }, border: { display: false },
        ticks: { color: '#9aa8ba', stepSize: 0.5, font: { family: 'Inter, system-ui, sans-serif', size: 10, weight: 400 as const } },
        title: { display: true, text: 'Left', color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: 500 as const } },
      },
      y: {
        min: -1, max: 1,
        grid: { color: 'rgba(255,255,255,0.06)' }, border: { display: false },
        ticks: { color: '#9aa8ba', stepSize: 0.5, font: { family: 'Inter, system-ui, sans-serif', size: 10, weight: 400 as const } },
        title: { display: true, text: 'Right', color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: 500 as const } },
      },
    },
  }), []);

  // ─── Render Helpers ────────────────────────────────────────────────────────

  const statBoxStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '8px',
    padding: '0.8rem 0.7rem',
    position: 'relative',
  };

  const tooltipTriggerStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: '0.3rem', cursor: 'help',
  };

  const StatCard = ({ title, tooltip, children }: { title: string; tooltip: string; children: React.ReactNode }) => (
    <div style={statBoxStyle} title={tooltip}>
      <div className="stat-title" style={{ fontSize: '0.65rem', marginBottom: '0.4rem' }}>
        <span style={tooltipTriggerStyle}>
          {title}
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.4, flexShrink: 0 }}>
            <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/>
            <text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="600">?</text>
          </svg>
        </span>
      </div>
      {children}
    </div>
  );

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ marginTop: '1rem' }}>
      {/* File upload & Analyze */}
      <div className="glass-panel">
        <div className="controls-row">
          <div className="file-input-wrapper">
            <button className="button-primary" style={{ background: 'rgba(255,255,255,0.1)', boxShadow: 'none', maxWidth: '100%' }}>
              <MusicalNoteIcon width={20} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {file ? file.name : 'Select Audio File'}
              </span>
            </button>
            <input ref={fileInputRef} type="file" accept="audio/*,.flac,.wav,.mp3" onChange={handleFileChange} />
          </div>
          <button className="button-primary" onClick={handleAnalyze} disabled={!file || isProcessing}>
            {isProcessing ? 'Processing...' : 'Analyze'}
          </button>
        </div>
        {isProcessing && (
          <div style={{ marginTop: '1.5rem' }}>
            <div className="progress-container"><div className="progress-bar" style={{ width: `${progress}%` }}></div></div>
            <div className="status-text">{statusText}</div>
          </div>
        )}
      </div>

      {data && (
        <>
          {/* ── Stat Cards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${data.isStereo ? 7 : 5}, 1fr)`, gap: '0.6rem', marginTop: '2rem' }}>
            <StatCard title="Integrated LUFS" tooltip="Overall perceived loudness of the track (ITU-R BS.1770). Target: -14 LUFS for streaming, -16 for podcasts.">
              <div className="stat-value" style={{ fontSize: '1.4rem' }}>{data.lufs === -Infinity ? '-inf' : data.lufs.toFixed(1)}</div>
            </StatCard>
            <StatCard title="True Peak" tooltip="Maximum inter-sample peak level (4x oversampled). Should stay below -1 dBTP to avoid clipping after codec encoding.">
              <div className="stat-value" style={{ fontSize: '1.4rem', color: data.truePeakDb > -1 ? '#ff6b6b' : 'var(--text-primary)' }}>
                {data.truePeakDb === -Infinity ? '-inf' : data.truePeakDb.toFixed(1)} <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>dBTP</span>
              </div>
            </StatCard>
            <StatCard title="Crest Factor" tooltip="Peak-to-RMS ratio. Higher values = more dynamic. Heavily limited masters typically show 4–8 dB, dynamic mixes 12–20 dB.">
              <div className="stat-value" style={{ fontSize: '1.4rem' }}>{data.crestFactorDb.toFixed(1)} <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>dB</span></div>
            </StatCard>
            <StatCard title="LRA" tooltip="Loudness Range (EBU R128). Measures the variation in loudness over time. <5 LU = heavily compressed, 5–10 = moderate, >10 = wide dynamics.">
              <div className="stat-value" style={{ fontSize: '1.4rem' }}>{data.lra.toFixed(1)} <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>LU</span></div>
            </StatCard>
            <StatCard title="PLR" tooltip="Peak-to-Loudness Ratio (true peak minus integrated LUFS). Indicates headroom and limiting. Lower values = more aggressive limiting.">
              <div className="stat-value" style={{ fontSize: '1.4rem' }}>{isFinite(data.plr) ? data.plr.toFixed(1) : '--'} <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>dB</span></div>
            </StatCard>
            {data.isStereo && (
              <>
                <StatCard title="Correlation" tooltip="Stereo correlation coefficient. 1 = mono, 0 = uncorrelated, <0 = out of phase (mono compatibility issues). Stay above 0.3 for safe playback.">
                  <div className="stat-value" style={{ fontSize: '1.4rem', color: data.overallCorrelation < 0 ? '#ff6b6b' : data.overallCorrelation < 0.3 ? '#ffcc33' : '#66ff66' }}>
                    {data.overallCorrelation.toFixed(3)}
                  </div>
                </StatCard>
                <StatCard title="M/S Balance" tooltip="Mid vs Side energy ratio in dB. Positive = more center content, negative = wider stereo. Typical masters: +3 to +8 dB.">
                  <div className="stat-value" style={{ fontSize: '1.4rem' }}>
                    {isFinite(data.midSideRatioDb) ? `${data.midSideRatioDb > 0 ? '+' : ''}${data.midSideRatioDb.toFixed(1)}` : 'Mono'}
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}> dB</span>
                  </div>
                </StatCard>
              </>
            )}
          </div>

          {/* ── Sub-view Tabs ── */}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '2rem', borderBottom: '1px solid rgba(255,255,255,0.1)', flexWrap: 'wrap' }}>
            {SUB_VIEWS.map(sv => (
              <button
                key={sv.key}
                onClick={() => setSubView(sv.key)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: subView === sv.key ? 'var(--accent-color)' : 'var(--text-secondary)',
                  padding: '0.75rem 1rem', fontSize: '0.9rem', fontWeight: 500,
                  borderBottom: subView === sv.key ? '2px solid var(--accent-color)' : '2px solid transparent',
                  transition: 'all 0.15s', marginBottom: '-1px',
                  fontFamily: 'Inter, system-ui, sans-serif',
                }}
              >
                {sv.label}
              </button>
            ))}
          </div>

          {/* ── Spectrum View ── */}
          {subView === 'spectrum' && (
            <div style={{ marginTop: '1.5rem' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>Tilt:</span>
                {ROLLOFF_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setActiveSlope(opt.value)} style={{
                    background: activeSlope === opt.value ? 'rgba(255,255,255,0.1)' : 'transparent',
                    border: `1px solid ${activeSlope === opt.value ? ROLLOFF_COLORS[opt.value] : 'rgba(255,255,255,0.15)'}`,
                    color: activeSlope === opt.value ? ROLLOFF_COLORS[opt.value] : 'var(--text-secondary)',
                    padding: '0.3rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', cursor: 'pointer',
                    transition: 'all 0.15s', fontFamily: 'Inter, system-ui, sans-serif',
                    fontWeight: activeSlope === opt.value ? 600 : 400,
                  }}>{opt.label}</button>
                ))}
              </div>
              <div className="chart-container" style={{ height: '420px' }}>
                {spectrumChartData && <Scatter data={spectrumChartData} options={spectrumChartOptions as any} />}
              </div>
            </div>
          )}

          {/* ── Waveform View ── */}
          {subView === 'waveform' && (
            <div style={{ marginTop: '1.5rem' }}>
              {data.clippingCount > 0 && (
                <div style={{ padding: '0.6rem 1rem', background: 'rgba(255,100,100,0.1)', border: '1px solid rgba(255,100,100,0.3)', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.85rem', color: '#ff6b6b' }}>
                  {data.clippingCount} clipping sample{data.clippingCount > 1 ? 's' : ''} detected
                </div>
              )}
              <div className="chart-container" style={{ height: '300px' }}>
                {waveformChartData && <Line data={waveformChartData} options={waveformOptions as any} />}
              </div>
              <div style={{ marginTop: '0.5rem', display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                <span><span style={{ display: 'inline-block', width: 12, height: 8, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.6)', marginRight: 4, verticalAlign: 'middle' }}></span> Peak</span>
                <span><span style={{ display: 'inline-block', width: 12, height: 2, background: 'rgba(0,240,255,0.6)', marginRight: 4, verticalAlign: 'middle' }}></span> RMS</span>
              </div>
            </div>
          )}

          {/* ── Dynamics View ── */}
          {subView === 'dynamics' && (
            <div style={{ marginTop: '1.5rem' }}>
              <h2 className="panel-title">Short-Term Loudness Over Time</h2>
              <div className="chart-container" style={{ height: '350px' }}>
                {dynamicsChartData && <Line data={dynamicsChartData} options={dynamicsOptions as any} />}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginTop: '1.5rem' }}>
                <div style={statBoxStyle}>
                  <div className="stat-title">Loudness Range (LRA)</div>
                  <div className="stat-value" style={{ fontSize: '2rem' }}>{data.lra.toFixed(1)} <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>LU</span></div>
                  <div className="stat-subtext">{data.lra < 5 ? 'Heavily compressed' : data.lra < 10 ? 'Moderate dynamics' : 'Wide dynamic range'}</div>
                </div>
                <div style={statBoxStyle}>
                  <div className="stat-title">Crest Factor</div>
                  <div className="stat-value" style={{ fontSize: '2rem' }}>{data.crestFactorDb.toFixed(1)} <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>dB</span></div>
                  <div className="stat-subtext">Peak-to-RMS ratio</div>
                </div>
                <div style={statBoxStyle}>
                  <div className="stat-title">PLR</div>
                  <div className="stat-value" style={{ fontSize: '2rem' }}>{isFinite(data.plr) ? data.plr.toFixed(1) : '--'} <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>dB</span></div>
                  <div className="stat-subtext">Peak-to-Loudness Ratio</div>
                </div>
              </div>
            </div>
          )}

          {/* ── Stereo Field View ── */}
          {subView === 'stereo' && (
            <div style={{ marginTop: '1.5rem' }}>
              {!data.isStereo ? (
                <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
                  This file is mono — stereo analysis is not available.
                </div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
                    {/* Lissajous */}
                    <div>
                      <h2 className="panel-title">Lissajous (X/Y)</h2>
                      <div style={{ maxWidth: '400px', margin: '0 auto' }}>
                        {lissajousChartData && <Scatter data={lissajousChartData} options={lissajousOptions as any} />}
                      </div>
                      <div style={{ textAlign: 'center', marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        Diagonal = mono | Circle = wide stereo | Anti-diagonal = out of phase
                      </div>
                    </div>

                    {/* Stats */}
                    <div>
                      <h2 className="panel-title">Stereo Metrics</h2>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <div style={statBoxStyle}>
                          <div className="stat-title">Overall Correlation</div>
                          <div className="stat-value" style={{
                            fontSize: '2.5rem',
                            color: data.overallCorrelation < 0 ? '#ff6b6b' : data.overallCorrelation < 0.3 ? '#ffcc33' : '#66ff66',
                          }}>
                            {data.overallCorrelation.toFixed(3)}
                          </div>
                          <div className="stat-subtext">
                            {data.overallCorrelation > 0.8 ? 'Very narrow / mostly mono' :
                             data.overallCorrelation > 0.5 ? 'Good stereo balance' :
                             data.overallCorrelation > 0 ? 'Wide stereo image' :
                             'Phase issues detected'}
                          </div>
                        </div>
                        <div style={statBoxStyle}>
                          <div className="stat-title">Mid/Side Balance</div>
                          <div className="stat-value" style={{ fontSize: '2rem' }}>
                            {isFinite(data.midSideRatioDb) ? `${data.midSideRatioDb > 0 ? '+' : ''}${data.midSideRatioDb.toFixed(1)} dB` : 'Pure Mono'}
                          </div>
                          <div className="stat-subtext">
                            {data.midSideRatioDb > 10 ? 'Very mid-heavy' :
                             data.midSideRatioDb > 3 ? 'Mid-dominant' :
                             data.midSideRatioDb > -3 ? 'Balanced M/S' :
                             'Side-heavy (wide)'}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Correlation over time */}
                  <div style={{ marginTop: '2rem' }}>
                    <h2 className="panel-title">Correlation Over Time</h2>
                    <div className="chart-container" style={{ height: '200px' }}>
                      {correlationChartData && <Line data={correlationChartData} options={correlationOptions as any} />}
                    </div>
                    <div style={{ marginTop: '0.5rem', display: 'flex', gap: '1.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#66ff66', marginRight: 4, verticalAlign: 'middle' }}></span> &gt;0.3 (safe)</span>
                      <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#ffcc33', marginRight: 4, verticalAlign: 'middle' }}></span> 0–0.3 (wide)</span>
                      <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#ff6b6b', marginRight: 4, verticalAlign: 'middle' }}></span> &lt;0 (phase issues)</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
