import { useState, useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import { MusicalNoteIcon } from '@heroicons/react/24/outline';

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface TransientData {
  // Onset times in seconds
  onsets: number[];
  // Density over time (onsets per second, windowed)
  density: { time: number; value: number }[];
  // Energy envelope
  energy: { time: number; value: number }[];
  duration: number;
  totalOnsets: number;
  avgDensity: number;
  peakDensity: { time: number; value: number };
}

export default function TransientDensity() {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [data, setData] = useState<TransientData | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) setFile(e.target.files[0]);
  };

  const handleAnalyze = async () => {
    if (!file) return;
    setIsProcessing(true);
    setProgress(0);
    setStatusText('Reading file...');
    setData(null);

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

      const totalSamples = decoded.length;
      const sampleRate = decoded.sampleRate;
      const duration = decoded.duration;
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
      setStatusText('Computing spectral flux for onset detection...');
      await new Promise(r => setTimeout(r, 20));

      // Energy-based onset detection using spectral flux
      const frameSize = 1024;
      const hopSize = 512;
      const numFrames = Math.floor((totalSamples - frameSize) / hopSize) + 1;

      // Compute RMS energy per frame
      const frameEnergies: number[] = [];
      for (let f = 0; f < numFrames; f++) {
        const start = f * hopSize;
        let sumSq = 0;
        for (let i = start; i < start + frameSize && i < totalSamples; i++) {
          sumSq += mono[i] * mono[i];
        }
        frameEnergies.push(Math.sqrt(sumSq / frameSize));

        if (f % 5000 === 0) {
          setProgress(25 + Math.round((f / numFrames) * 30));
          await new Promise(r => setTimeout(r, 0));
        }
      }

      setProgress(60);
      setStatusText('Detecting onsets...');
      await new Promise(r => setTimeout(r, 20));

      // Onset detection: look for significant energy increases
      // Use a local adaptive threshold
      const onsets: number[] = [];
      const windowSize = 20; // frames for local average
      const threshold = 1.5; // multiplier above local average
      const minOnsetGap = Math.round(0.05 * sampleRate / hopSize); // 50ms minimum gap

      let lastOnsetFrame = -minOnsetGap;

      for (let f = 1; f < numFrames; f++) {
        const diff = frameEnergies[f] - frameEnergies[f - 1];
        if (diff <= 0) continue;

        // Local average of positive diffs
        let localSum = 0, localCount = 0;
        for (let j = Math.max(1, f - windowSize); j < Math.min(numFrames, f + windowSize); j++) {
          const d = frameEnergies[j] - frameEnergies[j - 1];
          if (d > 0) { localSum += d; localCount++; }
        }
        const localAvg = localCount > 0 ? localSum / localCount : 0;

        if (diff > localAvg * threshold && (f - lastOnsetFrame) >= minOnsetGap) {
          onsets.push((f * hopSize) / sampleRate);
          lastOnsetFrame = f;
        }
      }

      setProgress(80);
      setStatusText('Computing transient density...');
      await new Promise(r => setTimeout(r, 20));

      // Compute density (onsets per second in a 2-second sliding window, 0.5s hop)
      const densityWindowSec = 2;
      const densityHopSec = 0.5;
      const density: { time: number; value: number }[] = [];

      for (let t = 0; t + densityWindowSec <= duration; t += densityHopSec) {
        const windowStart = t;
        const windowEnd = t + densityWindowSec;
        const count = onsets.filter(o => o >= windowStart && o < windowEnd).length;
        density.push({ time: t + densityWindowSec / 2, value: count / densityWindowSec });
      }

      // Energy envelope (downsampled)
      const energyPoints = 500;
      const energyStep = Math.max(1, Math.floor(numFrames / energyPoints));
      const energy: { time: number; value: number }[] = [];
      for (let f = 0; f < numFrames; f += energyStep) {
        energy.push({
          time: (f * hopSize) / sampleRate,
          value: frameEnergies[f],
        });
      }

      const avgDensity = density.length > 0 ? density.reduce((a, d) => a + d.value, 0) / density.length : 0;
      let peakDensity = { time: 0, value: 0 };
      for (const d of density) {
        if (d.value > peakDensity.value) peakDensity = d;
      }

      setData({
        onsets,
        density,
        energy,
        duration,
        totalOnsets: onsets.length,
        avgDensity,
        peakDensity,
      });

      setProgress(100);
      setStatusText('Analysis complete!');
      setIsProcessing(false);
    } catch (err) {
      console.error('Transient analysis error:', err);
      setStatusText(`Error: ${(err as Error).message}`);
      setIsProcessing(false);
    }
  };

  const densityChartData = useMemo(() => {
    if (!data) return null;
    return {
      labels: data.density.map(d => formatTime(d.time)),
      datasets: [{
        label: 'Transient Density',
        data: data.density.map(d => d.value),
        borderColor: 'rgba(0, 240, 255, 0.8)',
        backgroundColor: 'rgba(0, 240, 255, 0.08)',
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: 0.3,
      }],
    };
  }, [data]);

  const energyChartData = useMemo(() => {
    if (!data) return null;
    return {
      labels: data.energy.map(e => formatTime(e.time)),
      datasets: [{
        label: 'RMS Energy',
        data: data.energy.map(e => e.value),
        borderColor: 'rgba(255, 180, 50, 0.7)',
        backgroundColor: 'rgba(255, 180, 50, 0.06)',
        borderWidth: 1,
        pointRadius: 0,
        fill: true,
        tension: 0.2,
      }],
    };
  }, [data]);

  const chartOptions = (yLabel: string, minY?: number) => ({
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(0,0,0,0.85)', padding: 10, cornerRadius: 4, displayColors: false,
        titleFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
        bodyFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: 400 as const },
      },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: '#9aa8ba', maxTicksLimit: 15, font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: 400 as const } } },
      y: {
        min: minY ?? 0,
        grid: { color: 'rgba(255,255,255,0.06)' }, border: { display: false },
        ticks: { color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: 400 as const } },
        title: { display: true, text: yLabel, color: '#9aa8ba', font: { family: 'Inter, system-ui, sans-serif', size: 12, weight: 500 as const } },
      },
    },
  });

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
            {isProcessing ? 'Processing...' : 'Analyze Transients'}
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
          {/* Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginTop: '2rem' }}>
            <div style={statBoxStyle}>
              <div className="stat-title">Total Onsets</div>
              <div className="stat-value" style={{ fontSize: '2rem' }}>{data.totalOnsets}</div>
            </div>
            <div style={statBoxStyle}>
              <div className="stat-title">Avg Density</div>
              <div className="stat-value" style={{ fontSize: '2rem' }}>{data.avgDensity.toFixed(1)} <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>/sec</span></div>
            </div>
            <div style={statBoxStyle}>
              <div className="stat-title">Peak Density</div>
              <div className="stat-value" style={{ fontSize: '2rem' }}>{data.peakDensity.value.toFixed(1)} <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>/sec</span></div>
              <div className="stat-subtext">at {formatTime(data.peakDensity.time)}</div>
            </div>
            <div style={statBoxStyle}>
              <div className="stat-title">Duration</div>
              <div className="stat-value" style={{ fontSize: '2rem' }}>{formatTime(data.duration)}</div>
            </div>
          </div>

          {/* Density chart */}
          <div style={{ marginTop: '2rem' }}>
            <h2 className="panel-title">Transient Density Over Time</h2>
            <div className="chart-container" style={{ height: '300px' }}>
              {densityChartData && <Line data={densityChartData} options={chartOptions('Onsets / sec') as any} />}
            </div>
          </div>

          {/* Energy envelope */}
          <div style={{ marginTop: '2rem' }}>
            <h2 className="panel-title">RMS Energy Envelope</h2>
            <div className="chart-container" style={{ height: '250px' }}>
              {energyChartData && <Line data={energyChartData} options={chartOptions('RMS Level') as any} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
