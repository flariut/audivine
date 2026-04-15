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

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, annotationPlugin);

interface BpmPoint {
  time: number;
  bpm: number;
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');

  // Basic Settings
  const [smoothingWindow, setSmoothingWindow] = useState(5);
  const [minBpm, setMinBpm] = useState(60);
  const [maxBpm, setMaxBpm] = useState(200);
  const [enableTimeSig, setEnableTimeSig] = useState(false);

  // Advanced BPM Improvements (hidden menu)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [enableOutlierRejection, setEnableOutlierRejection] = useState(true);
  const [enableOctaveLocking, setEnableOctaveLocking] = useState(true);
  const [enableContinuityConstraint, setEnableContinuityConstraint] = useState(true);
  const [enableOnsetCrossValidation, setEnableOnsetCrossValidation] = useState(true);
  const [enableWeightedMedian, setEnableWeightedMedian] = useState(true);
  const [outlierStrictness, setOutlierStrictness] = useState(1.5); // IQR multiplier
  const [continuityMaxJump, setContinuityMaxJump] = useState(8); // max % BPM jump between adjacent points

  const [bpmData, setBpmData] = useState<BpmPoint[]>([]);
  const [globalBpm, setGlobalBpm] = useState<number | null>(null);
  const [medianBpm, setMedianBpm] = useState<number | null>(null);
  const [meanBpm, setMeanBpm] = useState<number | null>(null);
  // Tab State
  const [activeTab, setActiveTab] = useState<'analyzer' | 'taptempo' | 'spectrum' | 'transients' | 'key' | 'compare'>('analyzer');

  const [timeSigs, setTimeSigs] = useState<{ time: number, sig: string }[]>([]);
  const [songMeta, setSongMeta] = useState<{ title?: string, artist?: string } | null>(null);

  // Tap Tempo State
  const [taps, setTaps] = useState<number[]>([]);
  const [lastTapBpm, setLastTapBpm] = useState<number | null>(null);
  const [lastTapCount, setLastTapCount] = useState(0);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      setSongMeta(null);

      try {
        const metadata = await mm.parseBlob(selectedFile, {
          duration: false,
          skipCovers: true
        });
        if (metadata.common.title || metadata.common.artist) {
          setSongMeta({
            title: metadata.common.title,
            artist: metadata.common.artist
          });
        }
      } catch (err) {
        console.warn("No ID3 metadata found or parse error", err);
      }
    }
  };

  const handleProcess = async () => {
    if (!file) return;
    setIsProcessing(true);
    setProgress(0);
    setStatusText('Reading file...');
    setBpmData([]);
    setGlobalBpm(null);
    setMedianBpm(null);
    setMeanBpm(null);
    setTimeSigs([]);

    try {
      const arrayBuffer = await file.arrayBuffer();

      setStatusText('Decoding audio data...');
      setProgress(5);

      const rawAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const decodedData = await rawAudioCtx.decodeAudioData(arrayBuffer);

      setStatusText('Resampling to 44.1kHz...');
      setProgress(10);

      const targetRate = 44100;
      let resampledBuffer = decodedData;

      if (decodedData.sampleRate !== targetRate) {
        const offlineCtx = new OfflineAudioContext(
          decodedData.numberOfChannels,
          Math.ceil(decodedData.length * targetRate / decodedData.sampleRate),
          targetRate
        );
        const source = offlineCtx.createBufferSource();
        source.buffer = decodedData;
        source.connect(offlineCtx.destination);
        source.start(0);
        resampledBuffer = await offlineCtx.startRendering();
      }

      setStatusText('Initializing ML Engine (Essentia)...');
      setProgress(15);

      if (!(window as any).essentiaInstance) {
        if (EssentiaWASM && typeof EssentiaWASM === 'function') {
          const mod = await EssentiaWASM();
          (window as any).essentiaInstance = new Essentia(mod);
        } else if (EssentiaWASM.EssentiaJS) {
          (window as any).essentiaInstance = new Essentia(EssentiaWASM);
        } else {
          await new Promise<void>((resolve) => {
            EssentiaWASM.onRuntimeInitialized = () => {
              (window as any).essentiaInstance = new Essentia(EssentiaWASM);
              resolve();
            };
            setTimeout(() => {
              if (EssentiaWASM.EssentiaJS && !(window as any).essentiaInstance) {
                (window as any).essentiaInstance = new Essentia(EssentiaWASM);
                resolve();
              }
            }, 500);
          });
        }
      }
      const essentia = (window as any).essentiaInstance;

      setProgress(25);
      await new Promise(r => setTimeout(r, 50));

      try {
        setStatusText('Downmixing to Mono...');
        const totalSamples = resampledBuffer.length;
        let monoData: Float32Array;
        if (resampledBuffer.numberOfChannels > 1) {
          const left = resampledBuffer.getChannelData(0);
          const right = resampledBuffer.getChannelData(1);
          monoData = new Float32Array(totalSamples);
          for (let i = 0; i < totalSamples; i++) {
            monoData[i] = (left[i] + right[i]) / 2;
          }
        } else {
          monoData = resampledBuffer.getChannelData(0);
        }

        // ── Onset-based cross-validation (spectral flux) ──
        let onsetBpmEstimate: number | null = null;
        if (enableOnsetCrossValidation) {
          setProgress(30);
          setStatusText('Computing onset-based tempo estimate...');
          await new Promise(r => setTimeout(r, 30));

          const frameSize = 1024;
          const hopSize = 512;
          const numFrames = Math.floor((monoData.length - frameSize) / hopSize);
          const onsetStrength = new Float32Array(numFrames);

          // Compute spectral flux (half-wave rectified difference of magnitude spectra)
          let prevMag: Float32Array | null = null;
          const fftSize = frameSize;
          const halfFFT = fftSize / 2;

          for (let f = 0; f < numFrames; f++) {
            const offset = f * hopSize;
            let sumMag = 0;
            // Simple magnitude estimate using sum of absolute values (fast proxy for spectral energy)
            const curMag = new Float32Array(halfFFT);
            for (let i = 0; i < fftSize; i++) {
              const bin = Math.floor(i / 2);
              if (bin < halfFFT) curMag[bin] += Math.abs(monoData[offset + i]);
            }
            if (prevMag) {
              for (let i = 0; i < halfFFT; i++) {
                const diff = curMag[i] - prevMag[i];
                if (diff > 0) sumMag += diff;
              }
            }
            onsetStrength[f] = sumMag;
            prevMag = curMag;
          }

          // Autocorrelation of onset strength to find periodicity
          const minLag = Math.round(60 / maxBpm * targetRate / hopSize);
          const maxLag = Math.round(60 / minBpm * targetRate / hopSize);
          let bestLag = minLag;
          let bestCorr = -Infinity;

          for (let lag = minLag; lag <= Math.min(maxLag, numFrames / 2); lag++) {
            let corr = 0;
            const len = Math.min(numFrames - lag, 2000);
            for (let i = 0; i < len; i++) {
              corr += onsetStrength[i] * onsetStrength[i + lag];
            }
            // Weight by perceptual preference for tempos near 120 BPM
            const bpmAtLag = 60 / (lag * hopSize / targetRate);
            const tempoWeight = Math.exp(-0.5 * Math.pow((bpmAtLag - 120) / 60, 2));
            corr *= (1 + 0.3 * tempoWeight);

            if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
          }
          onsetBpmEstimate = 60 / (bestLag * hopSize / targetRate);
        }

        setProgress(50);
        setStatusText('Running RhythmExtractor2013...');
        await new Promise(r => setTimeout(r, 50));

        const inputVector = essentia.arrayToVector(monoData);
        const result = essentia.RhythmExtractor2013(inputVector);

        let inferredGlobalBpm = result.bpm;
        const confidence = result.confidence;
        const ticks = essentia.vectorToArray(result.ticks);
        inputVector.delete();

        // ── Cross-validate global BPM with onset estimate ──
        if (enableOnsetCrossValidation && onsetBpmEstimate !== null) {
          // Check if Essentia's BPM is a doubling/halving of onset estimate
          const ratio = inferredGlobalBpm / onsetBpmEstimate;
          if (ratio > 1.8 && ratio < 2.2) {
            // Essentia may be doubling — prefer onset if it's in range
            if (onsetBpmEstimate >= minBpm && onsetBpmEstimate <= maxBpm) {
              inferredGlobalBpm = (inferredGlobalBpm + onsetBpmEstimate * 2) / 3; // weighted blend
            }
          } else if (ratio > 0.45 && ratio < 0.55) {
            if (onsetBpmEstimate >= minBpm && onsetBpmEstimate <= maxBpm) {
              inferredGlobalBpm = (inferredGlobalBpm * 2 + onsetBpmEstimate) / 3;
            }
          }
        }
        setGlobalBpm(inferredGlobalBpm);

        setProgress(70);
        setStatusText('Calculating Tempo Flow...');

        // ── Calculate raw instantaneous BPM ──
        let rawBpmPoints: BpmPoint[] = [];
        for (let i = 1; i < ticks.length; i++) {
          const beatInterval = ticks[i] - ticks[i - 1];
          if (beatInterval > 0) {
            const instantaneousBpm = 60.0 / beatInterval;
            rawBpmPoints.push({
              time: (ticks[i] + ticks[i - 1]) / 2,
              bpm: instantaneousBpm
            });
          }
        }

        // ── Octave Locking: determine dominant octave from histogram ──
        if (enableOctaveLocking && rawBpmPoints.length > 0) {
          setStatusText('Octave locking...');
          // Build histogram of BPM values in 1-BPM bins within the range
          const bins = new Map<number, number>();
          for (const p of rawBpmPoints) {
            // Try all octave variants of this BPM
            let b = p.bpm;
            while (b > maxBpm * 1.5) b /= 2;
            while (b < minBpm / 1.5) b *= 2;
            // Now try both b and b*2 and b/2 within range
            const candidates = [b, b * 2, b / 2].filter(v => v >= minBpm - 5 && v <= maxBpm + 5);
            for (const c of candidates) {
              const binKey = Math.round(c);
              bins.set(binKey, (bins.get(binKey) || 0) + 1);
            }
          }

          // Find the peak of the histogram (dominant tempo)
          let dominantBpm = inferredGlobalBpm;
          let maxCount = 0;
          for (const [bpm, count] of bins) {
            if (count > maxCount) { maxCount = count; dominantBpm = bpm; }
          }

          // Lock all raw points to the closest octave of the dominant BPM
          rawBpmPoints = rawBpmPoints.map(p => {
            let b = p.bpm;
            // Find the octave of b closest to dominantBpm
            let bestDist = Infinity;
            let bestB = b;
            for (let mult = 0.25; mult <= 4; mult *= 2) {
              const candidate = b * mult;
              if (candidate >= minBpm - 5 && candidate <= maxBpm + 5) {
                const dist = Math.abs(candidate - dominantBpm);
                if (dist < bestDist) { bestDist = dist; bestB = candidate; }
              }
            }
            return { time: p.time, bpm: bestB };
          });
        } else {
          // Fallback: old doubling/halving heuristic
          rawBpmPoints = rawBpmPoints.map(p => {
            let b = p.bpm;
            while (b < minBpm && b * 2 <= maxBpm + 5) b *= 2;
            while (b > maxBpm && b / 2 >= minBpm - 5) b /= 2;
            return { time: p.time, bpm: b };
          });
        }

        // Filter to range
        rawBpmPoints = rawBpmPoints.filter(p => p.bpm >= minBpm - 5 && p.bpm <= maxBpm + 5);

        // ── IQR-based Outlier Rejection ──
        if (enableOutlierRejection && rawBpmPoints.length > 4) {
          setStatusText('Rejecting outliers...');
          const sorted = rawBpmPoints.map(p => p.bpm).sort((a, b) => a - b);
          const q1 = sorted[Math.floor(sorted.length * 0.25)];
          const q3 = sorted[Math.floor(sorted.length * 0.75)];
          const iqr = q3 - q1;
          const lowerFence = q1 - outlierStrictness * iqr;
          const upperFence = q3 + outlierStrictness * iqr;
          rawBpmPoints = rawBpmPoints.filter(p => p.bpm >= lowerFence && p.bpm <= upperFence);
        }

        // ── Tempo Continuity Constraint ──
        if (enableContinuityConstraint && rawBpmPoints.length > 2) {
          setStatusText('Applying continuity constraint...');
          const maxJumpFraction = continuityMaxJump / 100;
          const filtered: BpmPoint[] = [rawBpmPoints[0]];

          for (let i = 1; i < rawBpmPoints.length; i++) {
            const prev = filtered[filtered.length - 1].bpm;
            const curr = rawBpmPoints[i].bpm;
            const jumpRatio = Math.abs(curr - prev) / prev;

            if (jumpRatio <= maxJumpFraction) {
              filtered.push(rawBpmPoints[i]);
            } else {
              // Clamp to max allowed jump toward the new value
              const direction = curr > prev ? 1 : -1;
              const clampedBpm = prev + direction * prev * maxJumpFraction;
              filtered.push({ time: rawBpmPoints[i].time, bpm: clampedBpm });
            }
          }
          rawBpmPoints = filtered;
        }

        setProgress(85);
        setStatusText('Smoothing...');

        // ── Smoothing (optimized with binary search boundaries) ──
        const smoothedPoints: BpmPoint[] = [];
        for (let idx = 0; idx < rawBpmPoints.length; idx++) {
          const point = rawBpmPoints[idx];
          const windowStart = point.time - smoothingWindow / 2;
          const windowEnd = point.time + smoothingWindow / 2;

          // Find window bounds efficiently
          let lo = idx, hi = idx;
          while (lo > 0 && rawBpmPoints[lo - 1].time >= windowStart) lo--;
          while (hi < rawBpmPoints.length - 1 && rawBpmPoints[hi + 1].time <= windowEnd) hi++;

          if (enableWeightedMedian) {
            // Weighted median: points closer in time get more weight
            const windowPoints = rawBpmPoints.slice(lo, hi + 1);
            const centerTime = point.time;
            const halfWin = smoothingWindow / 2;

            // Sort by BPM for median calculation
            const weighted = windowPoints.map(p => ({
              bpm: p.bpm,
              weight: 1 - Math.abs(p.time - centerTime) / (halfWin + 0.01), // linear decay
            })).sort((a, b) => a.bpm - b.bpm);

            const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
            let cumWeight = 0;
            let medianBpmValue = weighted[0].bpm;
            for (const w of weighted) {
              cumWeight += w.weight;
              if (cumWeight >= totalWeight / 2) {
                medianBpmValue = w.bpm;
                break;
              }
            }
            smoothedPoints.push({ time: point.time, bpm: Math.round(medianBpmValue * 10) / 10 });
          } else {
            // Simple moving average
            let sum = 0, count = 0;
            for (let j = lo; j <= hi; j++) { sum += rawBpmPoints[j].bpm; count++; }
            smoothedPoints.push({ time: point.time, bpm: Math.round((sum / count) * 10) / 10 });
          }
        }

        // ── Calculate Mean and Median from cleaned data ──
        if (smoothedPoints.length > 0) {
          const allBpms = smoothedPoints.map(p => p.bpm);
          const sumBpm = allBpms.reduce((a, b) => a + b, 0);
          setMeanBpm(sumBpm / allBpms.length);
          const sortedBpms = [...allBpms].sort((a, b) => a - b);
          const mid = Math.floor(sortedBpms.length / 2);
          setMedianBpm(sortedBpms.length % 2 !== 0 ? sortedBpms[mid] : (sortedBpms[mid - 1] + sortedBpms[mid]) / 2);
        }

        // ── Time Signature Heuristic ──
        if (enableTimeSig && ticks.length > 12) {
          setStatusText('Extrapolating Time Signatures...');
          const sigs: { time: number, sig: string }[] = [];
          const sampleRate = 44100;
          const getRms = (t: number) => {
            const start = Math.max(0, Math.floor((t - 0.025) * sampleRate));
            const end = Math.min(monoData.length, Math.floor((t + 0.025) * sampleRate));
            let sumSq = 0;
            for (let j = start; j < end; j++) sumSq += monoData[j] * monoData[j];
            return Math.sqrt(sumSq / (end - start || 1));
          };
          const tickEnergies = Array.from(ticks).map(t => getRms(Number(t)));
          let lastSig = "";
          for (let i = 0; i < ticks.length - 12; i += 4) {
            const score4 = (tickEnergies[i] + tickEnergies[i + 4] + tickEnergies[i + 8]) / 3;
            const score3 = (tickEnergies[i] + tickEnergies[i + 3] + tickEnergies[i + 6] + tickEnergies[i + 9]) / 4;
            let currentSig = "Unknown";
            if (score4 > score3 * 1.1) currentSig = "4/4";
            else if (score3 > score4 * 1.1) currentSig = "3/4";
            if (currentSig !== "Unknown" && currentSig !== lastSig) {
              sigs.push({ time: ticks[i], sig: currentSig });
              lastSig = currentSig;
            }
          }
          setTimeSigs(sigs);
        }

        setBpmData(smoothedPoints);
        setProgress(100);
        setStatusText(`Analysis Complete! (Confidence: ${confidence.toFixed(2)})`);
        setIsProcessing(false);

      } catch (e) {
        console.warn('Analysis error:', e);
        setStatusText('Error during ML pattern analysis.');
        setIsProcessing(false);
      }

    } catch (err: any) {
      console.error(err);
      setStatusText('Error processing audio.');
      setIsProcessing(false);
    }
  };

  const chartData = {
    labels: bpmData.map(p => {
      const mins = Math.floor(p.time / 60);
      const secs = Math.floor(p.time % 60);
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }),
    datasets: [
      {
        label: 'Flow',
        data: bpmData.map(p => p.bpm),
        borderColor: '#ffffff',
        backgroundColor: 'rgba(255, 255, 255, 0.02)',
        borderWidth: 1.5,
        tension: 0.5,
        fill: true,
        pointBackgroundColor: 'transparent',
        pointBorderColor: 'transparent',
        pointHoverBackgroundColor: '#ffffff',
        pointHoverBorderColor: '#ffffff'
      }
    ]
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(0,0,0,0.8)',
        titleFont: { family: 'Inter, system-ui, sans-serif', size: 14, weight: 400 as const },
        bodyFont: { family: 'Inter, system-ui, sans-serif', size: 14, weight: 400 as const },
        padding: 12,
        cornerRadius: 4,
        displayColors: false,
      },
      annotation: {
        annotations: timeSigs.map((sig) => {
          let xIdx = bpmData.findIndex(p => p.time >= sig.time);
          if (xIdx === -1) xIdx = bpmData.length - 1;

          return {
            type: 'line' as const,
            xMin: xIdx,
            xMax: xIdx,
            borderColor: 'rgba(255, 255, 255, 0.4)',
            borderWidth: 1.5,
            borderDash: [4, 4],
            label: {
              display: true,
              content: sig.sig,
              position: 'start' as const,
              backgroundColor: 'rgba(0,0,0,0.8)',
              color: '#fff',
              font: { family: 'Inter, system-ui, sans-serif', weight: 500 as const, size: 14 },
              padding: 6
            }
          };
        })
      }
    },
    scales: {
      y: {
        min: minBpm - 10,
        max: maxBpm + 10,
        grid: { color: 'rgba(255,255,255,0.1)', drawBorder: false },
        ticks: { color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 14, weight: 400 as const } },
        border: { display: false }
      },
      x: {
        grid: { display: false, drawBorder: false },
        ticks: { color: '#9aa8ba', maxTicksLimit: 10, font: { family: 'Inter, system-ui, sans-serif', size: 14, weight: 400 as const } },
        border: { display: false }
      }
    }
  };

  const formattedGlobal = globalBpm ? globalBpm.toFixed(1) : '--';
  const formattedMedian = medianBpm ? medianBpm.toFixed(1) : '--';
  const formattedMean = meanBpm ? meanBpm.toFixed(1) : '--';

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getMinMax = () => {
    if (bpmData.length === 0) return { max: null, min: null };
    let max = bpmData[0], min = bpmData[0];
    bpmData.forEach(p => {
      if (p.bpm > max.bpm) max = p;
      if (p.bpm < min.bpm) min = p;
    });
    return { max, min };
  };
  const { max, min } = getMinMax();

  // Tap Tempo Logic
  const handleTap = useCallback(() => {
    const now = performance.now();
    setLastTapBpm(null); // Clear expired state — we're live again
    setLastTapCount(0);
    setTaps(prev => {
      if (prev.length > 0 && now - prev[prev.length - 1] > 3000) {
        return [now];
      }
      return [...prev, now];
    });
  }, []);

  const resetTaps = useCallback(() => setTaps([]), []);

  // Auto-reset tapping session after 3 seconds of inactivity
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    if (taps.length > 1) {
      timeoutId = setTimeout(() => {
        // Save the current BPM before clearing
        const elapsedMs = taps[taps.length - 1] - taps[0];
        const minutes = elapsedMs / 60000;
        setLastTapBpm((taps.length - 1) / minutes);
        setLastTapCount(taps.length);
        resetTaps();
      }, 3000);
    } else if (taps.length === 1) {
      timeoutId = setTimeout(() => {
        resetTaps();
      }, 3000);
    }
    return () => clearTimeout(timeoutId);
  }, [taps, resetTaps]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeTab === 'taptempo' && e.key !== 'Escape' && e.key !== 'Tab') {
        if (e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault(); // Prevent scrolling
        }
        handleTap();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, handleTap]);

  let tapBpm: number | null = null;
  if (taps.length > 1) {
    const elapsedMs = taps[taps.length - 1] - taps[0];
    const minutes = elapsedMs / 60000;
    tapBpm = (taps.length - 1) / minutes;
  }

  // Display values: prefer live, fall back to last session
  const isLive = tapBpm !== null;
  const displayBpm = tapBpm ?? lastTapBpm;
  const displayCount = taps.length > 0 ? taps.length : lastTapCount;
  const tapBpmFormatted = displayBpm ? displayBpm.toFixed(2) : '--';
  const tapBpmWhole = displayBpm ? Math.round(displayBpm).toString() : '--';
  const tapAccent = isLive ? 'var(--accent-color)' : 'rgba(255, 170, 50, 0.9)';

  return (
    <div className="app-container">
      <header className="header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
          <div>
            <h1>Audivine</h1>
            <p>Audio Intelligence in the Browser</p>
          </div>
          <a
            href="https://ko-fi.com/YOUR_USERNAME"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.5rem 1rem', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 600,
              background: 'rgba(255, 90, 95, 0.1)', border: '1px solid rgba(255, 90, 95, 0.3)',
              color: '#ff5a5f', textDecoration: 'none', transition: 'all 0.2s',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255, 90, 95, 0.2)'; e.currentTarget.style.borderColor = 'rgba(255, 90, 95, 0.5)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255, 90, 95, 0.1)'; e.currentTarget.style.borderColor = 'rgba(255, 90, 95, 0.3)'; }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path d="M23.881 8.948c-.773-4.085-4.859-4.593-4.859-4.593H.723c-.604 0-.679.798-.679.798s-.082 7.324-.022 11.822c.164 2.424 2.586 2.672 2.586 2.672s8.267-.023 11.966-.049c2.438-.426 2.683-2.566 2.658-3.734 4.352.24 7.422-2.831 6.649-6.916zm-11.062 3.511c-1.246 1.453-4.011 3.976-4.011 3.976s-.121.119-.31.023c-.076-.057-.108-.09-.108-.09-.443-.441-3.368-3.049-4.034-3.954-.709-.965-1.041-2.7-.091-3.71.951-1.01 3.005-1.086 4.363.407 0 0 1.565-1.782 3.468-.963 1.904.82 1.832 3.011.723 4.311z"/>
            </svg>
            Support on Ko-fi
          </a>
        </div>

        <div className="tabs-container" style={{ marginTop: '2rem', display: 'flex', gap: '1rem', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <button
            className={`tab-btn ${activeTab === 'analyzer' ? 'active' : ''}`}
            onClick={() => setActiveTab('analyzer')}
            style={{
              background: 'transparent', border: 'none', color: activeTab === 'analyzer' ? 'var(--accent-color)' : 'var(--text-secondary)',
              padding: '1rem 0', fontSize: '1.1rem', fontWeight: 500, cursor: 'pointer', borderBottom: activeTab === 'analyzer' ? '2px solid var(--accent-color)' : '2px solid transparent',
              display: 'flex', alignItems: 'center', gap: '0.5rem', transition: 'all 0.2s', marginBottom: '-1px'
            }}
          >
            <ChartBarIcon width={20} /> BPM Analyzer
          </button>
          <button
            className={`tab-btn ${activeTab === 'taptempo' ? 'active' : ''}`}
            onClick={() => setActiveTab('taptempo')}
            style={{
              background: 'transparent', border: 'none', color: activeTab === 'taptempo' ? 'var(--accent-color)' : 'var(--text-secondary)',
              padding: '1rem 0', fontSize: '1.1rem', fontWeight: 500, cursor: 'pointer', borderBottom: activeTab === 'taptempo' ? '2px solid var(--accent-color)' : '2px solid transparent',
              display: 'flex', alignItems: 'center', gap: '0.5rem', transition: 'all 0.2s', marginBottom: '-1px'
            }}
          >
            <CursorArrowRaysIcon width={20} /> Tap Tempo
          </button>
          <button
            className={`tab-btn ${activeTab === 'spectrum' ? 'active' : ''}`}
            onClick={() => setActiveTab('spectrum')}
            style={{
              background: 'transparent', border: 'none', color: activeTab === 'spectrum' ? 'var(--accent-color)' : 'var(--text-secondary)',
              padding: '1rem 0', fontSize: '1.1rem', fontWeight: 500, cursor: 'pointer', borderBottom: activeTab === 'spectrum' ? '2px solid var(--accent-color)' : '2px solid transparent',
              display: 'flex', alignItems: 'center', gap: '0.5rem', transition: 'all 0.2s', marginBottom: '-1px'
            }}
          >
            <SignalIcon width={20} /> Spectrum
          </button>
          <button
            className={`tab-btn ${activeTab === 'transients' ? 'active' : ''}`}
            onClick={() => setActiveTab('transients')}
            style={{
              background: 'transparent', border: 'none', color: activeTab === 'transients' ? 'var(--accent-color)' : 'var(--text-secondary)',
              padding: '1rem 0', fontSize: '1.1rem', fontWeight: 500, cursor: 'pointer', borderBottom: activeTab === 'transients' ? '2px solid var(--accent-color)' : '2px solid transparent',
              display: 'flex', alignItems: 'center', gap: '0.5rem', transition: 'all 0.2s', marginBottom: '-1px'
            }}
          >
            <BoltIcon width={20} /> Transients
          </button>
          <button
            className={`tab-btn ${activeTab === 'key' ? 'active' : ''}`}
            onClick={() => setActiveTab('key')}
            style={{
              background: 'transparent', border: 'none', color: activeTab === 'key' ? 'var(--accent-color)' : 'var(--text-secondary)',
              padding: '1rem 0', fontSize: '1.1rem', fontWeight: 500, cursor: 'pointer', borderBottom: activeTab === 'key' ? '2px solid var(--accent-color)' : '2px solid transparent',
              display: 'flex', alignItems: 'center', gap: '0.5rem', transition: 'all 0.2s', marginBottom: '-1px'
            }}
          >
            <KeyIcon width={20} /> Key
          </button>
          <button
            className={`tab-btn ${activeTab === 'compare' ? 'active' : ''}`}
            onClick={() => setActiveTab('compare')}
            style={{
              background: 'transparent', border: 'none', color: activeTab === 'compare' ? 'var(--accent-color)' : 'var(--text-secondary)',
              padding: '1rem 0', fontSize: '1.1rem', fontWeight: 500, cursor: 'pointer', borderBottom: activeTab === 'compare' ? '2px solid var(--accent-color)' : '2px solid transparent',
              display: 'flex', alignItems: 'center', gap: '0.5rem', transition: 'all 0.2s', marginBottom: '-1px'
            }}
          >
            <ArrowsRightLeftIcon width={20} /> Compare
          </button>
        </div>
      </header>

      {activeTab === 'analyzer' && (
        <>
          <div className="dashboard-grid">
            {/* Top Controls */}
            <div className="glass-panel">
              <h2 className="panel-title"><Cog6ToothIcon width={24} /> Settings</h2>

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

                <div className="control-group">
                  <label>
                    Smoothing Window
                    <span className="control-value">{smoothingWindow}s</span>
                  </label>
                  <input
                    type="range"
                    min="0.5" max="20" step="0.5"
                    value={smoothingWindow}
                    onChange={e => setSmoothingWindow(Number(e.target.value))}
                  />
                </div>

                <div className="bpm-limits">
                  <div className="control-group">
                    <label>Min BPM</label>
                    <input
                      type="number"
                      value={minBpm}
                      onChange={e => setMinBpm(Number(e.target.value))}
                    />
                  </div>
                  <div className="control-group">
                    <label>Max BPM</label>
                    <input
                      type="number"
                      value={maxBpm}
                      onChange={e => setMaxBpm(Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className="control-group" style={{ flex: '1 1 100%' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', textTransform: 'none', color: 'var(--text-primary)', justifyContent: 'flex-start', width: 'max-content' }}>
                    <input
                      type="checkbox"
                      checked={enableTimeSig}
                      onChange={e => setEnableTimeSig(e.target.checked)}
                      style={{ width: '16px', height: '16px', accentColor: 'var(--accent-color)', margin: 0 }}
                    />
                    Detect Time Signatures (Experimental)
                  </label>
                </div>

                {/* Advanced toggle */}
                <div style={{ flex: '1 1 100%' }}>
                  <button
                    onClick={() => setShowAdvanced(prev => !prev)}
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--text-secondary)', fontSize: '0.8rem', padding: '0.25rem 0',
                      display: 'flex', alignItems: 'center', gap: '0.4rem',
                      fontFamily: 'Inter, system-ui, sans-serif', letterSpacing: '0.03em',
                    }}
                  >
                    <span style={{ display: 'inline-block', transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', fontSize: '0.7rem' }}>&#9654;</span>
                    Advanced BPM Engine
                  </button>

                  {showAdvanced && (
                    <div style={{
                      marginTop: '0.75rem', padding: '1rem', borderRadius: '8px',
                      background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
                      display: 'flex', flexDirection: 'column', gap: '0.75rem',
                    }}>
                      {/* Toggle switches */}
                      {[
                        { label: 'IQR Outlier Rejection', desc: 'Remove wild BPM spikes using interquartile range filtering', state: enableOutlierRejection, set: setEnableOutlierRejection },
                        { label: 'Octave Locking', desc: 'Lock all values to the dominant tempo octave (prevents 70/140 flip-flopping)', state: enableOctaveLocking, set: setEnableOctaveLocking },
                        { label: 'Tempo Continuity', desc: 'Penalize sudden BPM jumps between adjacent beats', state: enableContinuityConstraint, set: setEnableContinuityConstraint },
                        { label: 'Onset Cross-Validation', desc: 'Use spectral flux autocorrelation to verify Essentia\'s global BPM', state: enableOnsetCrossValidation, set: setEnableOnsetCrossValidation },
                        { label: 'Weighted Median Smoothing', desc: 'Use time-weighted median instead of mean (more outlier-resistant)', state: enableWeightedMedian, set: setEnableWeightedMedian },
                      ].map(toggle => (
                        <label key={toggle.label} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={toggle.state}
                            onChange={e => toggle.set(e.target.checked)}
                            style={{ width: '14px', height: '14px', accentColor: 'var(--accent-color)', margin: '2px 0 0 0', flexShrink: 0 }}
                          />
                          <div>
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 500 }}>{toggle.label}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '1px' }}>{toggle.desc}</div>
                          </div>
                        </label>
                      ))}

                      {/* Numeric controls */}
                      <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                        <div className="control-group" style={{ flex: '1 1 120px' }}>
                          <label>
                            Outlier Strictness (IQR)
                            <span className="control-value">{outlierStrictness}x</span>
                          </label>
                          <input
                            type="range" min="1" max="3" step="0.1"
                            value={outlierStrictness}
                            onChange={e => setOutlierStrictness(Number(e.target.value))}
                            disabled={!enableOutlierRejection}
                            style={{ opacity: enableOutlierRejection ? 1 : 0.3 }}
                          />
                        </div>
                        <div className="control-group" style={{ flex: '1 1 120px' }}>
                          <label>
                            Max BPM Jump
                            <span className="control-value">{continuityMaxJump}%</span>
                          </label>
                          <input
                            type="range" min="2" max="20" step="1"
                            value={continuityMaxJump}
                            onChange={e => setContinuityMaxJump(Number(e.target.value))}
                            disabled={!enableContinuityConstraint}
                            style={{ opacity: enableContinuityConstraint ? 1 : 0.3 }}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  className="button-primary"
                  onClick={handleProcess}
                  disabled={!file || isProcessing}
                >
                  {isProcessing ? 'Processing...' : 'Analyze BPM'}
                </button>
              </div>

              {isProcessing && (
                <div style={{ marginTop: '1.5rem' }}>
                  <div className="progress-container">
                    <div className="progress-bar" style={{ width: `${progress}%` }}></div>
                  </div>
                  <div className="status-text">{statusText}</div>
                </div>
              )}
            </div>

            {/* Main Interface */}
            <main>
              <div className="glass-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>

                <div style={{ marginBottom: '2rem' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.5rem', fontWeight: 600 }}>
                    {songMeta ? 'Track Information' : 'Filename'}
                  </div>
                  <div style={{ fontSize: '1.75rem', color: 'var(--text-primary)', fontWeight: 300, letterSpacing: '-0.03em' }}>
                    {songMeta ? (
                      <>
                        <strong style={{ fontWeight: 500 }}>{songMeta.title || 'Unknown Title'}</strong>
                        {songMeta.artist && <span style={{ color: 'var(--text-secondary)', fontSize: '1.25rem', marginLeft: '0.75rem', fontWeight: 300 }}>— {songMeta.artist}</span>}
                      </>
                    ) : (
                      file ? file.name : 'No audio file selected'
                    )}
                  </div>
                </div>

                <h2 className="panel-title">BPM Analysis over Time</h2>
                <div className="chart-container">
                  {bpmData.length > 0 ? (
                    <Line data={chartData} options={chartOptions} />
                  ) : (
                    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
                      Upload a file and process to see the chart...
                    </div>
                  )}
                </div>
              </div>
            </main>
          </div>
          {bpmData.length > 0 && (
            <div className="summary-stats">
              <div className="stat-card">
                <div className="stat-title">Essentia Global</div>
                <div className="stat-value">{formattedGlobal}</div>
                <div className="stat-subtext">Overall Groove</div>
              </div>
              <div className="stat-card">
                <div className="stat-title">Median Tempo</div>
                <div className="stat-value">{formattedMedian}</div>
                <div className="stat-subtext">Outlier-Resistant</div>
              </div>
              <div className="stat-card">
                <div className="stat-title">Average Tempo</div>
                <div className="stat-value">{formattedMean}</div>
                <div className="stat-subtext">Mathematical Mean</div>
              </div>
              <div className="stat-card">
                <div className="stat-title">Min BPM</div>
                <div className="stat-value">{min?.bpm.toFixed(1)}</div>
                <div className="stat-subtext">at {formatTime(min?.time || 0)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-title">Max BPM</div>
                <div className="stat-value">{max?.bpm.toFixed(1)}</div>
                <div className="stat-subtext">at {formatTime(max?.time || 0)}</div>
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'spectrum' && (
        <SpectrumAnalyzer />
      )}

      {activeTab === 'transients' && (
        <TransientDensity />
      )}

      {activeTab === 'key' && (
        <KeyDetection />
      )}

      {activeTab === 'compare' && (
        <Comparator />
      )}

      {activeTab === 'taptempo' && (
        <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Main tap area — hero BPM + tap pad */}
          <div className="glass-panel" style={{ padding: '2rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '2rem', flexWrap: 'wrap' }}>

              {/* Tap button */}
              <button
                className="button-primary"
                onClick={handleTap}
                style={{
                  width: '140px', height: '140px', borderRadius: '50%', flexShrink: 0,
                  fontSize: '0.85rem', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase',
                  background: isLive ? 'rgba(0, 240, 255, 0.08)' : 'rgba(0, 240, 255, 0.04)',
                  border: `2px solid ${isLive ? 'rgba(0, 240, 255, 0.3)' : 'rgba(255,255,255,0.1)'}`,
                  color: isLive ? 'var(--accent-color)' : 'var(--text-secondary)',
                  boxShadow: isLive ? '0 0 40px rgba(0, 240, 255, 0.12), inset 0 0 30px rgba(0, 240, 255, 0.04)' : '0 0 20px rgba(0, 240, 255, 0.06)',
                  transition: 'all 0.1s ease',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
                  padding: 0,
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 18.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z" />
                  <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
                </svg>
                TAP
              </button>

              {/* Hero BPM readout */}
              <div style={{ flex: '1 1 200px', textAlign: 'center' }}>
                <div style={{
                  fontSize: '7rem', fontWeight: 200, lineHeight: 1, letterSpacing: '-0.04em',
                  color: displayBpm ? tapAccent : 'rgba(255,255,255,0.08)',
                  transition: 'color 0.3s',
                  fontVariantNumeric: 'tabular-nums',
                }}>{tapBpmWhole}</div>
                <div style={{ fontSize: '0.75rem', color: !isLive && displayBpm ? 'rgba(255, 170, 50, 0.5)' : 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.12em', marginTop: '0.25rem', fontWeight: 600, transition: 'color 0.3s' }}>
                  {!isLive && displayBpm ? 'LAST SESSION' : 'BPM'}
                </div>
              </div>

              {/* Stats column */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', minWidth: '150px', flexShrink: 0 }}>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: '0.2rem' }}>Precise</div>
                  <div style={{ fontSize: '1.8rem', fontWeight: 300, color: displayBpm && !isLive ? 'rgba(255, 170, 50, 0.7)' : 'var(--text-primary)', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', transition: 'color 0.3s' }}>{tapBpmFormatted}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: '0.2rem' }}>Taps</div>
                  <div style={{ fontSize: '1.8rem', fontWeight: 300, color: displayBpm && !isLive ? 'rgba(255, 170, 50, 0.7)' : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', transition: 'color 0.3s' }}>{displayCount}</div>
                </div>
                <button
                  className="button-primary"
                  onClick={() => { setLastTapBpm(null); setLastTapCount(0); resetTaps(); }}
                  disabled={taps.length === 0 && lastTapBpm === null}
                  style={{ background: 'transparent', borderColor: 'rgba(255,255,255,0.08)', padding: '0.5rem 0.75rem', fontSize: '0.8rem', gap: '0.35rem' }}
                >
                  <ArrowPathIcon width={14} /> Reset
                </button>
              </div>
            </div>

            {/* Hint */}
            <div style={{ marginTop: '1.25rem', textAlign: 'center', fontSize: '0.75rem', color: 'rgba(255,255,255,0.2)', letterSpacing: '0.02em' }}>
              {!isLive && displayBpm ? 'Tap to start a new session' : 'Press any key or click to tap — auto-resets after 3s of inactivity'}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
