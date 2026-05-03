//! LiveSet.io Audio Engine — browser-side WASM audio processing.
//!
//! Provides LUFS measurement, spectral tilt analysis, and loudness
//! normalization with true peak limiting. Runs entirely in the browser
//! via Web Workers — audio files never leave the user's machine.

mod lufs;
mod normalize;
mod tilt;
mod wav;

use serde::Serialize;
use wasm_bindgen::prelude::*;
use js_sys;

/// Audio analysis result returned to JavaScript.
#[derive(Serialize, Clone)]
pub struct AnalysisResult {
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_secs: f64,
    pub sample_count: u64,
    pub lufs_integrated: f64,
    pub lufs_short_term_max: f64,
    pub true_peak_dbfs: f64,
    pub spectral_tilt_db_per_oct: f64,
}

/// Normalization result returned to JavaScript.
#[derive(Serialize)]
pub struct NormalizationResult {
    /// The normalized WAV file bytes.
    pub wav_bytes: Vec<u8>,
    /// Analysis of the input file.
    pub input_analysis: AnalysisResult,
    /// Analysis of the output file.
    pub output_analysis: AnalysisResult,
    /// Gain applied in dB.
    pub gain_db: f64,
    /// Whether true peak limiting was applied.
    pub limiter_applied: bool,
}

/// Analyze a WAV file and return LUFS, true peak, and spectral tilt.
#[wasm_bindgen]
pub fn analyze_wav(data: &[u8]) -> Result<JsValue, JsValue> {
    let audio = wav::decode_audio(data).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let lufs = lufs::measure_lufs(&audio.samples, audio.sample_rate, audio.channels);
    let true_peak = lufs::true_peak_dbfs(&audio.samples, audio.channels);
    let spectral_tilt = tilt::measure_tilt(&audio.samples, audio.sample_rate, audio.channels);

    let result = AnalysisResult {
        sample_rate: audio.sample_rate,
        channels: audio.channels,
        duration_secs: audio.duration_secs(),
        sample_count: audio.sample_count(),
        lufs_integrated: lufs.integrated,
        lufs_short_term_max: lufs.short_term_max,
        true_peak_dbfs: true_peak,
        spectral_tilt_db_per_oct: spectral_tilt,
    };

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Normalize a WAV file to a target LUFS with optional tilt correction.
///
/// Parameters:
/// - `data`: WAV file bytes
/// - `target_lufs`: target integrated loudness (e.g., -14.0)
/// - `target_tilt`: target spectral tilt in dB/octave (e.g., -3.0), or 0.0 to skip
/// - `true_peak_limit`: maximum true peak in dBFS (e.g., -1.0)
#[wasm_bindgen]
pub fn normalize_wav(
    data: &[u8],
    target_lufs: f64,
    target_tilt: f64,
    true_peak_limit: f64,
) -> Result<JsValue, JsValue> {
    let audio = wav::decode_audio(data).map_err(|e| JsValue::from_str(&e.to_string()))?;

    // Analyze input
    let input_lufs = lufs::measure_lufs(&audio.samples, audio.sample_rate, audio.channels);
    let input_peak = lufs::true_peak_dbfs(&audio.samples, audio.channels);
    let input_tilt = tilt::measure_tilt(&audio.samples, audio.sample_rate, audio.channels);

    let input_analysis = AnalysisResult {
        sample_rate: audio.sample_rate,
        channels: audio.channels,
        duration_secs: audio.duration_secs(),
        sample_count: audio.sample_count(),
        lufs_integrated: input_lufs.integrated,
        lufs_short_term_max: input_lufs.short_term_max,
        true_peak_dbfs: input_peak,
        spectral_tilt_db_per_oct: input_tilt,
    };

    // Normalize
    let norm_result = normalize::normalize(
        &audio,
        target_lufs,
        target_tilt,
        true_peak_limit,
    );

    // Encode output WAV
    let wav_bytes = wav::encode_wav(
        &norm_result.samples,
        audio.sample_rate,
        audio.channels,
        audio.bits_per_sample,
    )
    .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // Analyze output
    let output_lufs = lufs::measure_lufs(&norm_result.samples, audio.sample_rate, audio.channels);
    let output_peak = lufs::true_peak_dbfs(&norm_result.samples, audio.channels);
    let output_tilt = tilt::measure_tilt(&norm_result.samples, audio.sample_rate, audio.channels);

    let output_analysis = AnalysisResult {
        sample_rate: audio.sample_rate,
        channels: audio.channels,
        duration_secs: audio.duration_secs(),
        sample_count: audio.sample_count(),
        lufs_integrated: output_lufs.integrated,
        lufs_short_term_max: output_lufs.short_term_max,
        true_peak_dbfs: output_peak,
        spectral_tilt_db_per_oct: output_tilt,
    };

    let result = NormalizationResult {
        wav_bytes,
        input_analysis,
        output_analysis,
        gain_db: norm_result.gain_db,
        limiter_applied: norm_result.limiter_applied,
    };

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Analyze the sum of multiple stems.
///
/// Takes a JS Array of Uint8Array WAV files, decodes them, sums the samples,
/// and returns the analysis of the mix. All stems must have the same sample
/// rate and channel count.
#[wasm_bindgen]
pub fn analyze_stems_sum(stems: js_sys::Array) -> Result<JsValue, JsValue> {
    if stems.length() == 0 {
        return Err(JsValue::from_str("No stems provided"));
    }

    // Decode all stems
    let mut decoded: Vec<wav::AudioData> = Vec::new();
    for i in 0..stems.length() {
        let val = stems.get(i);
        let arr = js_sys::Uint8Array::new(&val);
        let bytes = arr.to_vec();
        let audio = wav::decode_audio(&bytes)
            .map_err(|e| JsValue::from_str(&format!("Stem {}: {}", i, e)))?;
        decoded.push(audio);
    }

    // Validate all stems have matching format
    let sample_rate = decoded[0].sample_rate;
    let channels = decoded[0].channels;
    for (i, stem) in decoded.iter().enumerate().skip(1) {
        if stem.sample_rate != sample_rate {
            return Err(JsValue::from_str(&format!(
                "Stem {} has sample rate {} but stem 0 has {}",
                i, stem.sample_rate, sample_rate
            )));
        }
        if stem.channels != channels {
            return Err(JsValue::from_str(&format!(
                "Stem {} has {} channels but stem 0 has {}",
                i, stem.channels, channels
            )));
        }
    }

    // Sum all stems (use the longest stem's length)
    let max_len = decoded.iter().map(|s| s.samples.len()).max().unwrap_or(0);
    let mut sum_samples = vec![0.0f32; max_len];
    for stem in &decoded {
        for (i, &s) in stem.samples.iter().enumerate() {
            sum_samples[i] += s;
        }
    }

    // Analyze the sum
    let lufs_result = lufs::measure_lufs(&sum_samples, sample_rate, channels);
    let true_peak = lufs::true_peak_dbfs(&sum_samples, channels);
    let spectral_tilt = tilt::measure_tilt(&sum_samples, sample_rate, channels);
    let duration_secs = sum_samples.len() as f64 / channels as f64 / sample_rate as f64;

    let result = AnalysisResult {
        sample_rate,
        channels,
        duration_secs,
        sample_count: sum_samples.len() as u64,
        lufs_integrated: lufs_result.integrated,
        lufs_short_term_max: lufs_result.short_term_max,
        true_peak_dbfs: true_peak,
        spectral_tilt_db_per_oct: spectral_tilt,
    };

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Apply a fixed correction to a single stem WAV.
///
/// Used after `analyze_stems_sum` to apply the same correction to each stem.
#[wasm_bindgen]
pub fn correct_wav(
    data: &[u8],
    gain_db: f64,
    tilt_correction: f64,
    true_peak_limit: f64,
) -> Result<JsValue, JsValue> {
    let audio = wav::decode_audio(data).map_err(|e| JsValue::from_str(&e.to_string()))?;

    // Analyze input
    let input_lufs = lufs::measure_lufs(&audio.samples, audio.sample_rate, audio.channels);
    let input_peak = lufs::true_peak_dbfs(&audio.samples, audio.channels);
    let input_tilt = tilt::measure_tilt(&audio.samples, audio.sample_rate, audio.channels);

    let input_analysis = AnalysisResult {
        sample_rate: audio.sample_rate,
        channels: audio.channels,
        duration_secs: audio.duration_secs(),
        sample_count: audio.sample_count(),
        lufs_integrated: input_lufs.integrated,
        lufs_short_term_max: input_lufs.short_term_max,
        true_peak_dbfs: input_peak,
        spectral_tilt_db_per_oct: input_tilt,
    };

    // Apply correction
    let corrected = normalize::correct_audio(&audio, gain_db, tilt_correction, true_peak_limit);

    // Encode output
    let wav_bytes = wav::encode_wav(
        &corrected.samples,
        audio.sample_rate,
        audio.channels,
        audio.bits_per_sample,
    )
    .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // Analyze output
    let output_lufs = lufs::measure_lufs(&corrected.samples, audio.sample_rate, audio.channels);
    let output_peak = lufs::true_peak_dbfs(&corrected.samples, audio.channels);
    let output_tilt = tilt::measure_tilt(&corrected.samples, audio.sample_rate, audio.channels);

    let output_analysis = AnalysisResult {
        sample_rate: audio.sample_rate,
        channels: audio.channels,
        duration_secs: audio.duration_secs(),
        sample_count: audio.sample_count(),
        lufs_integrated: output_lufs.integrated,
        lufs_short_term_max: output_lufs.short_term_max,
        true_peak_dbfs: output_peak,
        spectral_tilt_db_per_oct: output_tilt,
    };

    let result = NormalizationResult {
        wav_bytes,
        input_analysis,
        output_analysis,
        gain_db: corrected.gain_db,
        limiter_applied: corrected.limiter_applied,
    };

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Batch-normalize multiple stems so their sum hits the target.
///
/// Unlike per-stem correction, peak limiting operates on the sum — individual
/// stems are never clipped, only attenuated equally when the sum would clip.
/// This preserves the mix balance while ensuring the sum hits both the LUFS
/// target and the peak limit.
///
/// Returns a JS object with:
/// - `stems`: Array of { wav_bytes, input_analysis, output_analysis }
/// - `mix_before`: AnalysisResult of the original sum
/// - `mix_after`: AnalysisResult of the corrected sum
/// - `gain_db`: total gain applied
/// - `tilt_correction`: tilt correction in dB/oct
/// - `limiter_applied`: whether peak limiting was needed
#[wasm_bindgen]
pub fn normalize_stems_batch(
    stems_js: js_sys::Array,
    target_lufs: f64,
    target_tilt: f64,
    true_peak_limit: f64,
) -> Result<JsValue, JsValue> {
    if stems_js.length() == 0 {
        return Err(JsValue::from_str("No stems provided"));
    }

    // Decode all stems
    let mut decoded: Vec<wav::AudioData> = Vec::new();
    for i in 0..stems_js.length() {
        let val = stems_js.get(i);
        let arr = js_sys::Uint8Array::new(&val);
        let bytes = arr.to_vec();
        let audio = wav::decode_audio(&bytes)
            .map_err(|e| JsValue::from_str(&format!("Stem {}: {}", i, e)))?;
        decoded.push(audio);
    }

    // Validate matching format
    let sample_rate = decoded[0].sample_rate;
    let channels = decoded[0].channels;
    let bits_per_sample = decoded[0].bits_per_sample;
    for (i, stem) in decoded.iter().enumerate().skip(1) {
        if stem.sample_rate != sample_rate {
            return Err(JsValue::from_str(&format!(
                "Stem {} has sample rate {} but stem 0 has {}",
                i, stem.sample_rate, sample_rate
            )));
        }
        if stem.channels != channels {
            return Err(JsValue::from_str(&format!(
                "Stem {} has {} channels but stem 0 has {}",
                i, stem.channels, channels
            )));
        }
    }

    // Compute input analysis for each stem first
    let mut input_analyses = Vec::new();
    for stem in &decoded {
        let in_lufs = lufs::measure_lufs(&stem.samples, sample_rate, channels);
        let in_peak = lufs::true_peak_dbfs(&stem.samples, channels);
        let in_tilt = tilt::measure_tilt(&stem.samples, sample_rate, channels);
        input_analyses.push(AnalysisResult {
            sample_rate,
            channels,
            duration_secs: stem.duration_secs(),
            sample_count: stem.sample_count(),
            lufs_integrated: in_lufs.integrated,
            lufs_short_term_max: in_lufs.short_term_max,
            true_peak_dbfs: in_peak,
            spectral_tilt_db_per_oct: in_tilt,
        });
    }

    // Analyze original sum (before)
    let max_len = decoded.iter().map(|s| s.samples.len()).max().unwrap_or(0);
    let mut sum_before = vec![0.0f32; max_len];
    for stem in &decoded {
        for (i, &s) in stem.samples.iter().enumerate() {
            sum_before[i] += s;
        }
    }
    let before_lufs = lufs::measure_lufs(&sum_before, sample_rate, channels);
    let before_peak = lufs::true_peak_dbfs(&sum_before, channels);
    let before_tilt = tilt::measure_tilt(&sum_before, sample_rate, channels);
    let duration_secs = sum_before.len() as f64 / channels as f64 / sample_rate as f64;

    let mix_before = AnalysisResult {
        sample_rate,
        channels,
        duration_secs,
        sample_count: sum_before.len() as u64,
        lufs_integrated: before_lufs.integrated,
        lufs_short_term_max: before_lufs.short_term_max,
        true_peak_dbfs: before_peak,
        spectral_tilt_db_per_oct: before_tilt,
    };
    
    drop(sum_before); // Free memory early

    // Run batch normalization IN PLACE
    let batch_result = normalize::normalize_stems_batch(
        &mut decoded,
        target_lufs,
        target_tilt,
        true_peak_limit,
    );

    // Analyze corrected sum (after)
    let mut sum_after = vec![0.0f32; max_len];
    for stem in &decoded {
        for (i, &s) in stem.samples.iter().enumerate() {
            sum_after[i] += s;
        }
    }
    let after_lufs = lufs::measure_lufs(&sum_after, sample_rate, channels);
    let after_peak = lufs::true_peak_dbfs(&sum_after, channels);
    let after_tilt = tilt::measure_tilt(&sum_after, sample_rate, channels);

    let mix_after = AnalysisResult {
        sample_rate,
        channels,
        duration_secs,
        sample_count: sum_after.len() as u64,
        lufs_integrated: after_lufs.integrated,
        lufs_short_term_max: after_lufs.short_term_max,
        true_peak_dbfs: after_peak,
        spectral_tilt_db_per_oct: after_tilt,
    };
    
    drop(sum_after); // Free memory early

    // Build per-stem results (encode WAV + analyze each)
    #[derive(Serialize)]
    struct StemOutput {
        wav_bytes: Vec<u8>,
        input_analysis: AnalysisResult,
        output_analysis: AnalysisResult,
    }

    #[derive(Serialize)]
    struct BatchOutput {
        stems: Vec<StemOutput>,
        mix_before: AnalysisResult,
        mix_after: AnalysisResult,
        gain_db: f64,
        tilt_correction: f64,
        limiter_applied: bool,
    }

    let mut stem_outputs = Vec::new();
    for (i, stem) in decoded.iter().enumerate() {
        let stem_duration = stem.duration_secs();

        // Output analysis
        let out_lufs = lufs::measure_lufs(&stem.samples, sample_rate, channels);
        let out_peak = lufs::true_peak_dbfs(&stem.samples, channels);
        let out_tilt = tilt::measure_tilt(&stem.samples, sample_rate, channels);

        let output_analysis = AnalysisResult {
            sample_rate,
            channels,
            duration_secs: stem_duration,
            sample_count: stem.samples.len() as u64,
            lufs_integrated: out_lufs.integrated,
            lufs_short_term_max: out_lufs.short_term_max,
            true_peak_dbfs: out_peak,
            spectral_tilt_db_per_oct: out_tilt,
        };

        // Encode WAV
        let wav_bytes = wav::encode_wav(&stem.samples, sample_rate, channels, bits_per_sample)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        stem_outputs.push(StemOutput {
            wav_bytes,
            input_analysis: input_analyses[i].clone(),
            output_analysis,
        });
    }

    let output = BatchOutput {
        stems: stem_outputs,
        mix_before,
        mix_after,
        gain_db: batch_result.gain_db,
        tilt_correction: batch_result.tilt_correction,
        limiter_applied: batch_result.limiter_applied,
    };

    serde_wasm_bindgen::to_value(&output).map_err(|e| JsValue::from_str(&e.to_string()))
}
