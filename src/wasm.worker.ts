import * as wasm from '../audio-engine/pkg/liveset_audio';

self.onmessage = async (e) => {
  const { type, payload, id } = e.data;
  
  try {
    if (type === 'ANALYZE') {
      const result = wasm.analyze_stems_sum(payload);
      
      // Transfer the original ArrayBuffers back to the main thread
      // to avoid memory duplication and crashes
      const transferables: ArrayBuffer[] = [];
      if (Array.isArray(payload)) {
        payload.forEach((u: any) => {
          if (u.buffer) transferables.push(u.buffer);
        });
      }
      
      self.postMessage({ id, type: 'SUCCESS', result, returnedStems: payload }, transferables);
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
      
      self.postMessage({ id, type: 'SUCCESS', result }, transferables);
    }
  } catch (error: any) {
    self.postMessage({ id, type: 'ERROR', error: error.toString() });
  }
};
