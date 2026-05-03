import * as wasm from '../audio-engine/pkg/liveset_audio';

self.onmessage = async (e) => {
  const { type, payload, id } = e.data;
  
  try {
    if (type === 'ANALYZE') {
      const result = wasm.analyze_stems_sum(payload);
      self.postMessage({ id, type: 'SUCCESS', result });
    } 
    else if (type === 'PROCESS') {
      const { stems, targetLufs, targetTilt, targetPeak } = payload;
      const result = wasm.normalize_stems_batch(stems, targetLufs, targetTilt, targetPeak);
      
      // Transfer ArrayBuffers to avoid memory cloning overhead
      const transferables: ArrayBuffer[] = [];
      if (result && result.stems) {
        result.stems.forEach((s: any) => {
          if (s.wav_bytes && s.wav_bytes.buffer) {
            transferables.push(s.wav_bytes.buffer);
          }
        });
      }
      
      self.postMessage({ id, type: 'SUCCESS', result }, { transfer: transferables });
    }
  } catch (error: any) {
    self.postMessage({ id, type: 'ERROR', error: error.toString() });
  }
};
