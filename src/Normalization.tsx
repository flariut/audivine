import React, { useState } from 'react';
import { ArchiveBoxArrowDownIcon, ArrowPathIcon, FolderPlusIcon, PresentationChartLineIcon } from '@heroicons/react/24/outline';
import WasmWorker from './wasm.worker.ts?worker';
import { zipSync } from 'fflate';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend } from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

interface SongFolder {
  id: string;
  name: string;
  files: { name: string; arrayBuffer: ArrayBuffer }[];
  status: 'pending' | 'analyzing' | 'ready' | 'processing' | 'done' | 'error';
  analysis?: any;
  processedFiles?: { name: string; uint8: Uint8Array }[];
  result?: any; // The result of normalization
  error?: string;
}

const TILT_PRESETS = [
  { name: 'Bright', value: -3.0 },
  { name: 'Balanced', value: -4.5 },
  { name: 'Warm', value: -6.0 }
];

const NumberInput = ({ value, onChange, min, max, step, disabled }: any) => {
  const [localVal, setLocalVal] = useState(String(value));

  React.useEffect(() => {
    setLocalVal(String(value));
  }, [value]);

  const handleBlur = () => {
    let num = Number(localVal);
    if (isNaN(num)) num = min;
    num = Math.min(max, Math.max(min, num));
    setLocalVal(String(num));
    onChange(num);
  };

  const handleInc = () => {
    if (disabled) return;
    let num = Number(localVal);
    if (isNaN(num)) num = 0;
    num = Math.min(max, num + step);
    num = Math.round(num * 100) / 100;
    setLocalVal(String(num));
    onChange(num);
  };

  const handleDec = () => {
    if (disabled) return;
    let num = Number(localVal);
    if (isNaN(num)) num = 0;
    num = Math.max(min, num - step);
    num = Math.round(num * 100) / 100;
    setLocalVal(String(num));
    onChange(num);
  };

  return (
    <div style={{ 
      display: 'flex', width: '100%', alignItems: 'center', 
      background: 'rgba(255, 255, 255, 0.05)', 
      border: '1px solid rgba(255, 255, 255, 0.1)', 
      borderRadius: '6px',
      opacity: disabled ? 0.5 : 1,
      transition: 'opacity 0.2s'
    }}>
      <button 
        disabled={disabled}
        onClick={(e) => { e.preventDefault(); handleDec(); }} 
        style={{ padding: '0.4rem 0.8rem', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '1.2rem', lineHeight: 1 }}
      >
        −
      </button>
      <input 
        type="text" 
        inputMode="decimal"
        value={localVal} 
        onChange={e => setLocalVal(e.target.value)}
        onBlur={handleBlur}
        disabled={disabled}
        style={{ 
          flex: 1, background: 'none', border: 'none', 
          textAlign: 'center', color: 'var(--text-primary)', 
          outline: 'none', fontSize: '0.9rem', padding: '0.5rem 0'
        }} 
      />
      <button 
        disabled={disabled}
        onClick={(e) => { e.preventDefault(); handleInc(); }} 
        style={{ padding: '0.4rem 0.8rem', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '1.2rem', lineHeight: 1 }}
      >
        +
      </button>
    </div>
  );
};

export default function Normalization() {
  const [folders, setFolders] = useState<SongFolder[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [worker, setWorker] = useState<Worker | null>(null);

  React.useEffect(() => {
    const w = new WasmWorker();
    setWorker(w);
    return () => w.terminate();
  }, []);

  const runWorkerTask = (type: string, payload: any, transferables: Transferable[] = []): Promise<any> => {
    return new Promise((resolve, reject) => {
      if (!worker) return reject(new Error("Worker not initialized"));
      const id = Math.random().toString(36).substring(7);
      
      const handleMessage = (e: MessageEvent) => {
        if (e.data.id === id) {
          worker.removeEventListener('message', handleMessage);
          if (e.data.type === 'SUCCESS') {
            resolve(e.data); // Return full message payload to access result and returnedStems
          } else {
            reject(new Error(e.data.error));
          }
        }
      };
      
      worker.addEventListener('message', handleMessage);
      worker.postMessage({ id, type, payload }, transferables);
    });
  };
  
  // Toggles
  const [enableLufs, setEnableLufs] = useState(true);
  const [targetLufs, setTargetLufs] = useState(-14.0);
  
  const [enableTilt, setEnableTilt] = useState(true);
  const [targetTilt, setTargetTilt] = useState(-3.0);
  
  const [enableTruePeak, setEnableTruePeak] = useState(true);
  const [truePeakLimit, setTruePeakLimit] = useState(-1.0);

  const [isProcessingAll, setIsProcessingAll] = useState(false);
  const isProcessingAllRef = React.useRef(false);

  const processEntry = async (entry: any, currentPath: string): Promise<{name: string, file: File}[]> => {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((file: File) => {
          const validExtensions = ['.wav', '.flac', '.aiff', '.aif'];
          if (validExtensions.some(ext => file.name.toLowerCase().endsWith(ext))) {
            resolve([{ name: currentPath + file.name, file }]);
          } else {
            resolve([]);
          }
        });
      } else if (entry.isDirectory) {
        const dirReader = entry.createReader();
        let allEntries: any[] = [];
        
        const readAllEntries = () => {
          return new Promise<any[]>((res) => {
            dirReader.readEntries((entries: any[]) => {
              if (entries.length === 0) {
                res(allEntries);
              } else {
                allEntries = allEntries.concat(entries);
                readAllEntries().then(res);
              }
            });
          });
        };

        readAllEntries().then(async (entries: any[]) => {
          let results: {name: string, file: File}[] = [];
          for (const child of entries) {
            const children = await processEntry(child, currentPath + entry.name + '/');
            results = results.concat(children);
          }
          resolve(results);
        });
      }
    });
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);

    if (e.dataTransfer.items) {
      // Must extract all entries synchronously because e.dataTransfer.items 
      // goes invalid as soon as we yield the event loop (await).
      const entries = Array.from(e.dataTransfer.items)
        .filter(item => item.kind === 'file')
        .map(item => item.webkitGetAsEntry())
        .filter(Boolean);

      const newFoldersMap = new Map<string, {name: string; arrayBuffer: ArrayBuffer}[]>();

      for (const entry of entries) {
        const files = await processEntry(entry, '');
        for (const { name, file } of files) {
          const parts = name.split('/');
          // Group by the top-level directory dropped, or 'Uncategorized' if just a file
          const folderName = parts.length > 1 ? parts[0] : 'Uncategorized';
          const buffer = await file.arrayBuffer();
          
          if (!newFoldersMap.has(folderName)) {
            newFoldersMap.set(folderName, []);
          }
          newFoldersMap.get(folderName)!.push({ name, arrayBuffer: buffer });
        }
      }

      const newSongFolders: SongFolder[] = Array.from(newFoldersMap.entries()).map(([name, files]) => ({
        id: crypto.randomUUID(),
        name,
        files,
        status: 'pending'
      }));

      if (newSongFolders.length > 0) {
        setFolders(prev => [...prev, ...newSongFolders]);
        analyzeFolders(newSongFolders);
      }
    }
  };

  const analyzeFolders = async (foldersToAnalyze: SongFolder[]) => {
    for (let i = 0; i < foldersToAnalyze.length; i++) {
      const folder = foldersToAnalyze[i];
      if (folder.status !== 'pending') continue;

      setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, status: 'analyzing' } : f));
      
      try {
        // Yield to allow React to paint the "analyzing" state
        await new Promise(r => setTimeout(r, 50));
        const uint8Arrays = folder.files.map(f => new Uint8Array(f.arrayBuffer));
        const transferables = uint8Arrays.map(u => u.buffer);
        
        const response = await runWorkerTask('ANALYZE', uint8Arrays, transferables);
        const analysis = response.result;
        const returnedStems = response.returnedStems;

        // Restore the ArrayBuffers back into the folder state so they can be processed later
        const updatedFiles = folder.files.map((f, idx) => ({
          ...f,
          arrayBuffer: returnedStems[idx].buffer
        }));
        
        setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, status: 'ready', analysis, files: updatedFiles } : f));
      } catch (err: any) {
        console.error("Analysis failed for", folder.name, err);
        setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, status: 'error', error: err.toString() } : f));
      }
    }
  };

  const handleProcessAll = async () => {
    if (isProcessingAllRef.current) return;
    isProcessingAllRef.current = true;
    setIsProcessingAll(true);
    
    let processedFolders = [...folders];

    for (let i = 0; i < processedFolders.length; i++) {
      const folder = processedFolders[i];
      if (folder.status === 'done' || folder.status === 'error') continue;

      setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, status: 'processing' } : f));

      try {
        // Pause UI briefly to let render catch up
        await new Promise(r => setTimeout(r, 50));
        
        const uint8Arrays = folder.files.map(f => new Uint8Array(f.arrayBuffer));
        const transferables = uint8Arrays.map(u => u.buffer);
        
        const lufsVal = enableLufs ? targetLufs : folder.analysis.lufs_integrated;
        const tiltVal = enableTilt ? targetTilt : 0.0;
        const peakVal = enableTruePeak ? truePeakLimit : 0.0; // 0.0 will just prevent huge clipping, but usually we pass the exact limit

        const response = await runWorkerTask('PROCESS', {
          stems: uint8Arrays,
          targetLufs: lufsVal,
          targetTilt: tiltVal,
          targetPeak: peakVal
        }, transferables);
        
        const result = response.result;
        
        const processedFiles = result.stems.map((stemRes: any, idx: number) => {
          // ensure extension is .wav
          let newName = folder.files[idx].name;
          newName = newName.replace(/\.(flac|aiff|aif)$/i, '.wav');
          return {
            name: newName,
            uint8: new Uint8Array(stemRes.wav_bytes)
          };
        });

        processedFolders[i] = { ...folder, status: 'done', result, processedFiles };
        setFolders(prev => prev.map(f => f.id === folder.id ? processedFolders[i] : f));
      } catch (err: any) {
        console.error("Process failed for", folder.name, err);
        processedFolders[i] = { ...folder, status: 'error', error: err.toString() };
        setFolders(prev => prev.map(f => f.id === folder.id ? processedFolders[i] : f));
      }
    }

    // Export to ZIP per folder to prevent Out of Memory crashes
    for (const folder of processedFolders) {
      if (folder.status === 'done' && folder.processedFiles && folder.processedFiles.length > 0) {
        try {
          const toZip: Record<string, Uint8Array> = {};
          for (const file of folder.processedFiles) {
            toZip[file.name] = file.uint8;
          }
          
          // Use level: 0 (Store) for WAV files to save massive amounts of CPU and memory
          const zipped = zipSync(toZip, { level: 0 });
          const blob = new Blob([zipped], { type: 'application/zip' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${folder.name}_Normalized.zip`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          
          // Give browser time to start download before revoking
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          
        } catch (err) {
          console.error(`Zip failed for ${folder.name}`, err);
          alert(`Failed to generate zip file for ${folder.name}`);
        }
      }
    }

    setIsProcessingAll(false);
  };

  const getTiltChartData = (tiltDbPerOct: number, processedTilt?: number, isPreview?: boolean) => {
    // Generate a simple frequency response curve based on the tilt
    const points = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    const octaves = points.map(p => Math.log2(p / 1000)); // normalized around 1kHz
    const originalData = octaves.map(o => o * tiltDbPerOct);
    
    const datasets: any[] = [
      {
        label: 'Original Tilt',
        data: originalData,
        borderColor: 'rgba(255, 255, 255, 0.3)',
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 0
      }
    ];

    if (processedTilt !== undefined) {
      const pData = octaves.map(o => o * processedTilt);
      datasets.push({
        label: isPreview ? 'Target Preview' : 'Processed Tilt',
        data: pData,
        borderColor: isPreview ? 'rgba(255, 90, 95, 0.5)' : 'var(--accent-color)',
        borderDash: isPreview ? [4, 4] : [],
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 0
      });
    }

    return {
      labels: points.map(String),
      datasets
    };
  };

  return (
    <div className="dashboard-grid">
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h2 className="panel-title"><PresentationChartLineIcon width={24} /> Batch Normalization</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
          Drag & drop folders of stems. The engine will analyze the sum of each folder to preserve the mix balance, and apply LUFS, Tilt, and Limiting corrections uniformly to all stems within the folder. Output is a structured .zip file of the processed .wav files.
        </p>

        <div className="controls-row">
          <div className="control-group">
            <label style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={enableLufs} onChange={e => setEnableLufs(e.target.checked)} />
              <span style={{ whiteSpace: 'nowrap' }}>Target LUFS</span>
            </label>
            <NumberInput 
              value={targetLufs} 
              onChange={(val: number) => setTargetLufs(val)} 
              min={-30} max={0} step={0.5} 
              disabled={!enableLufs} 
            />
          </div>

          <div className="control-group">
            <label style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={enableTilt} onChange={e => setEnableTilt(e.target.checked)} />
              <span style={{ whiteSpace: 'nowrap' }}>Target Tilt (dB/oct)</span>
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
              {TILT_PRESETS.map(p => (
                <button 
                  key={p.name} 
                  onClick={(e) => { e.preventDefault(); setTargetTilt(p.value); }}
                  disabled={!enableTilt}
                  style={{ 
                    flex: 1,
                    padding: '0.3rem', 
                    fontSize: '0.75rem', 
                    background: targetTilt === p.value ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
                    border: '1px solid',
                    borderColor: targetTilt === p.value ? 'var(--accent-color)' : 'rgba(255,255,255,0.1)',
                    borderRadius: '6px',
                    color: targetTilt === p.value ? '#000' : 'var(--text-primary)',
                    cursor: enableTilt ? 'pointer' : 'not-allowed',
                    transition: 'all 0.2s'
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <NumberInput 
              value={targetTilt} 
              onChange={(val: number) => setTargetTilt(val)} 
              min={-10} max={10} step={0.1} 
              disabled={!enableTilt} 
            />
          </div>

          <div className="control-group">
            <label style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={enableTruePeak} onChange={e => setEnableTruePeak(e.target.checked)} />
              <span style={{ whiteSpace: 'nowrap' }}>True Peak Limit (dBTP)</span>
            </label>
            <NumberInput 
              value={truePeakLimit} 
              onChange={(val: number) => setTruePeakLimit(val)} 
              min={-10} max={0} step={0.1} 
              disabled={!enableTruePeak} 
            />
          </div>
        </div>

        <div 
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          style={{
            border: `2px dashed ${isDragging ? 'var(--accent-color)' : 'rgba(255,255,255,0.2)'}`,
            borderRadius: '12px',
            padding: '3rem 2rem',
            textAlign: 'center',
            background: isDragging ? 'rgba(255, 90, 95, 0.05)' : 'rgba(0,0,0,0.2)',
            transition: 'all 0.2s',
            cursor: 'pointer',
            marginTop: '1rem'
          }}
        >
          <FolderPlusIcon width={48} style={{ color: isDragging ? 'var(--accent-color)' : 'rgba(255,255,255,0.4)', margin: '0 auto 1rem' }} />
          <h3 style={{ margin: '0 0 0.5rem', color: 'var(--text-primary)' }}>Drop Folders Here</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>Supports .wav, .flac, .aiff</p>
        </div>

        {folders.length > 0 && (
          <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'flex-end' }}>
            <button 
              className="button-primary" 
              onClick={handleProcessAll}
              disabled={isProcessingAll || folders.every(f => f.status === 'done')}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
            >
              {isProcessingAll ? <ArrowPathIcon width={20} className="spin" /> : <ArchiveBoxArrowDownIcon width={20} />}
              {isProcessingAll ? 'Processing & Zipping...' : 'Process All & Download'}
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
        {folders.map(folder => (
          <div key={folder.id} className="glass-panel" style={{ padding: '1.25rem', position: 'relative' }}>
            <h3 style={{ margin: '0 0 0.25rem', fontSize: '1.1rem', wordBreak: 'break-word', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {folder.name}
              {(folder.status === 'analyzing' || folder.status === 'processing') && (
                <ArrowPathIcon width={16} className="spin" style={{ color: 'var(--accent-color)' }} />
              )}
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 1rem' }}>
              {folder.files.length} stems
              {folder.status === 'analyzing' && ' • Analyzing...'}
              {folder.status === 'processing' && ' • Processing...'}
              {folder.status === 'done' && ' • Done'}
              {folder.status === 'error' && ' • Error'}
            </p>

            {folder.error && (
              <div style={{ background: 'rgba(255, 0, 0, 0.1)', color: '#ff6b6b', padding: '0.75rem', borderRadius: '6px', fontSize: '0.85rem' }}>
                {folder.error}
              </div>
            )}

            {(folder.analysis || folder.result) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>LUFS</span>
                  <span>
                    {folder.analysis?.lufs_integrated.toFixed(1)} 
                    {folder.result && ` → ${folder.result.mix_after.lufs_integrated.toFixed(1)}`} LU
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>True Peak</span>
                  <span>
                    {folder.analysis?.true_peak_dbfs.toFixed(1)} 
                    {folder.result && ` → ${folder.result.mix_after.true_peak_dbfs.toFixed(1)}`} dBTP
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Tilt</span>
                  <span>
                    {folder.analysis?.spectral_tilt_db_per_oct.toFixed(1)} 
                    {folder.result ? ` → ${folder.result.mix_after.spectral_tilt_db_per_oct.toFixed(1)}` : (enableTilt ? ` → ${targetTilt.toFixed(1)} (target)` : '')} dB/oct
                  </span>
                </div>
                
                {/* Mini Tilt Graphic */}
                <div style={{ height: '80px', marginTop: '0.5rem', background: 'rgba(0,0,0,0.2)', borderRadius: '6px', padding: '0.5rem' }}>
                  <Line 
                    data={getTiltChartData(
                      folder.analysis?.spectral_tilt_db_per_oct || 0, 
                      folder.result ? folder.result.mix_after.spectral_tilt_db_per_oct : (enableTilt ? targetTilt : undefined),
                      !folder.result
                    )}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: { legend: { display: false }, tooltip: { enabled: false } },
                      scales: {
                        x: { display: false },
                        y: { display: false, min: -15, max: 15 }
                      },
                      elements: { point: { radius: 0 } }
                    }}
                  />
                </div>
              </div>
            )}
            
            {folder.status === 'done' && (
              <div style={{ position: 'absolute', top: '1rem', right: '1rem', color: 'var(--accent-color)' }}>
                ✓
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
