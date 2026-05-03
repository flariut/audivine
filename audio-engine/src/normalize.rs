//! Loudness normalization with true peak limiting.
//!
//! Implements gain adjustment to reach a target LUFS level, with
//! optional spectral tilt correction and true peak limiting.

use crate::lufs;
use crate::tilt;
use crate::wav::AudioData;

/// Result of normalization processing.
pub struct NormalizeResult {
    /// Normalized audio samples (interleaved f32).
    pub samples: Vec<f32>,
    /// Gain applied in dB.
    pub gain_db: f64,
    /// Whether the true peak limiter was engaged.
    pub limiter_applied: bool,
}

/// Built-in normalization presets.
pub struct Preset {
    pub name: &'static str,
    pub target_lufs: f64,
    pub target_tilt: f64,
    pub true_peak_limit: f64,
}

/// Broadcast standard: EBU R128 (-14 LUFS, -3 dB/oct tilt).
pub const PRESET_BROADCAST: Preset = Preset {
    name: "broadcast",
    target_lufs: -14.0,
    target_tilt: -3.0,
    true_peak_limit: -1.0,
};

/// Live Loud: aggressive loudness for energetic performances.
pub const PRESET_LIVE_LOUD: Preset = Preset {
    name: "live_loud",
    target_lufs: -10.0,
    target_tilt: 0.0, // no tilt correction
    true_peak_limit: -0.5,
};

/// Live Warm: full, warm sound for acoustic/jazz sets.
pub const PRESET_LIVE_WARM: Preset = Preset {
    name: "live_warm",
    target_lufs: -12.0,
    target_tilt: -4.5,
    true_peak_limit: -1.0,
};

/// Normalize audio to a target LUFS with optional tilt correction.
///
/// Uses an iterative approach: after applying gain and true peak limiting,
/// re-measures LUFS and compensates if the limiter pulled the loudness
/// below the target. Converges within a few iterations.
pub fn normalize(
    audio: &AudioData,
    target_lufs: f64,
    target_tilt: f64,
    true_peak_limit: f64,
) -> NormalizeResult {
    let mut samples = audio.samples.clone();

    // Step 1: Apply tilt correction if current tilt differs from target
    let current_tilt = tilt::measure_tilt(&samples, audio.sample_rate, audio.channels);
    if (current_tilt - target_tilt).abs() > 0.3 {
        samples = tilt::apply_tilt_correction(
            &samples,
            audio.sample_rate,
            audio.channels,
            current_tilt,
            target_tilt,
        );
    }

    // Step 2: Iterative gain + limiting to reach target LUFS
    //
    // The limiter reduces peaks, which lowers overall loudness below the
    // target. We iterate: apply gain → limit → re-measure → compensate,
    // until LUFS converges on the target.
    const MAX_ITERATIONS: usize = 5;
    const TOLERANCE_DB: f64 = 0.5;

    let mut total_gain_db = 0.0_f64;
    let mut limiter_applied = false;

    for _ in 0..MAX_ITERATIONS {
        let current = lufs::measure_lufs(&samples, audio.sample_rate, audio.channels);

        if !current.integrated.is_finite() {
            break; // silence — nothing to do
        }

        let needed_db = target_lufs - current.integrated;

        if needed_db.abs() < TOLERANCE_DB {
            break; // close enough
        }

        // Clamp per-iteration gain to avoid wild swings
        let gain_db = needed_db.clamp(-30.0, 30.0);
        total_gain_db += gain_db;

        // Apply gain
        let gain_linear = 10.0_f64.powf(gain_db / 20.0) as f32;
        for sample in &mut samples {
            *sample *= gain_linear;
        }

        // Apply true peak limiting — if it engages, loop back to compensate
        if apply_true_peak_limiter(&mut samples, audio.channels, true_peak_limit) {
            limiter_applied = true;
        }
    }

    // Final safety pass: ensure true peak limit even if LUFS converged
    // without needing limiting (e.g., signal was already near target but
    // peaks exceeded the limit)
    if apply_true_peak_limiter(&mut samples, audio.channels, true_peak_limit) {
        limiter_applied = true;
    }

    NormalizeResult {
        samples,
        gain_db: total_gain_db,
        limiter_applied,
    }
}

/// Apply a fixed correction to a single stem.
///
/// Used for batch stem processing: the correction values (gain + tilt)
/// are computed from the sum of all stems, then applied identically to
/// each individual stem. This preserves the mix balance while hitting
/// the target on the sum.
pub fn correct_audio(
    audio: &AudioData,
    gain_db: f64,
    tilt_correction_per_oct: f64,
    true_peak_limit: f64,
) -> NormalizeResult {
    let mut samples = audio.samples.clone();

    // Step 1: Apply tilt correction if non-trivial
    if tilt_correction_per_oct.abs() > 0.1 {
        // We use apply_tilt_correction with current_tilt=0 and target=correction,
        // so it applies exactly the correction amount
        samples = tilt::apply_tilt_correction(
            &samples,
            audio.sample_rate,
            audio.channels,
            0.0,
            tilt_correction_per_oct,
        );
    }

    // Step 2: Apply gain
    let gain_linear = 10.0_f64.powf(gain_db / 20.0) as f32;
    for sample in &mut samples {
        *sample *= gain_linear;
    }

    // Step 3: True peak limiting
    let limiter_applied = apply_true_peak_limiter(&mut samples, audio.channels, true_peak_limit);

    NormalizeResult {
        samples,
        gain_db,
        limiter_applied,
    }
}

/// Result of batch stem normalization.
pub struct NormalizeStemsResult {
    /// Total gain applied in dB.
    pub gain_db: f64,
    /// Tilt correction applied in dB/octave.
    pub tilt_correction: f64,
    /// Whether the true peak limiter was engaged on the sum.
    pub limiter_applied: bool,
}

/// Normalize multiple stems so their sum hits the target.
///
/// Uses soft-knee limiting on the sum, then distributes the per-sample
/// attenuation back to individual stems. This preserves the mix balance
/// and average loudness (only peaks are reduced, not the whole signal).
///
/// Algorithm:
/// 1. Measure sum tilt, apply tilt correction to each stem
/// 2. Iterative gain loop on the sum's LUFS
/// 3. Soft-knee peak limiting on the sum, distributed to stems
pub fn normalize_stems_batch(
    stems: &mut [AudioData],
    target_lufs: f64,
    target_tilt: f64,
    true_peak_limit: f64,
) -> NormalizeStemsResult {
    let sample_rate = stems[0].sample_rate;
    let channels = stems[0].channels;

    // Find the longest stem (for summing)
    let max_len = stems.iter().map(|s| s.samples.len()).max().unwrap_or(0);

    // Step 1: Sum all stems to measure tilt
    let sum_samples = sum_stems_samples(stems, max_len);
    let current_tilt = tilt::measure_tilt(&sum_samples, sample_rate, channels);
    let tilt_correction = target_tilt - current_tilt;

    // Step 2: Apply tilt correction to each stem in place (if needed)
    if (current_tilt - target_tilt).abs() > 0.3 {
        for stem in stems.iter_mut() {
            let corrected_samples = tilt::apply_tilt_correction(
                &stem.samples,
                stem.sample_rate,
                stem.channels,
                current_tilt,
                target_tilt,
            );
            stem.samples = corrected_samples;
        }
    }

    // Step 3: Iterative gain to reach LUFS target on the sum
    const MAX_ITERATIONS: usize = 5;
    const TOLERANCE_DB: f64 = 0.5;

    let mut total_gain_db = 0.0_f64;
    let mut limiter_applied = false;

    for _ in 0..MAX_ITERATIONS {
        // Sum the corrected stems
        let mut sum = sum_stems_samples(stems, max_len);

        // Measure sum LUFS
        let current = lufs::measure_lufs(&sum, sample_rate, channels);
        if !current.integrated.is_finite() {
            break;
        }

        let needed_db = target_lufs - current.integrated;
        if needed_db.abs() < TOLERANCE_DB {
            break;
        }

        let gain_db = needed_db.clamp(-30.0, 30.0);
        total_gain_db += gain_db;

        // Apply gain to each stem
        let gain_linear = 10.0_f64.powf(gain_db / 20.0) as f32;
        for stem in stems.iter_mut() {
            for s in stem.samples.iter_mut() {
                *s *= gain_linear;
            }
        }

        // Step 4: Soft-knee limiting on the sum, distributed to stems
        sum = sum_stems_samples(stems, max_len);
        let mut sum_limited = sum.clone();
        if apply_true_peak_limiter(&mut sum_limited, channels, true_peak_limit) {
            limiter_applied = true;
            distribute_limiting_stems(stems, &sum, &sum_limited);
        }
    }

    // Final safety: one more limiting pass
    let final_sum = sum_stems_samples(stems, max_len);
    let mut final_sum_limited = final_sum.clone();
    if apply_true_peak_limiter(&mut final_sum_limited, channels, true_peak_limit) {
        limiter_applied = true;
        distribute_limiting_stems(stems, &final_sum, &final_sum_limited);
    }

    NormalizeStemsResult {
        gain_db: total_gain_db,
        tilt_correction,
        limiter_applied,
    }
}

fn distribute_limiting_stems(
    stems: &mut [AudioData],
    sum_unlimited: &[f32],
    sum_limited: &[f32],
) {
    for i in 0..sum_unlimited.len() {
        let abs_unlimited = sum_unlimited[i].abs();
        if abs_unlimited < 1e-10 {
            continue; // avoid division by zero on silence
        }
        let ratio = sum_limited[i] / sum_unlimited[i];
        if (ratio - 1.0).abs() < 1e-6 {
            continue; // no limiting at this sample
        }
        for stem in stems.iter_mut() {
            if i < stem.samples.len() {
                stem.samples[i] *= ratio;
            }
        }
    }
}

/// Sum AudioData stems into one sample vector.
fn sum_stems_samples(stems: &[AudioData], max_len: usize) -> Vec<f32> {
    let mut sum = vec![0.0f32; max_len];
    for stem in stems {
        for (i, &s) in stem.samples.iter().enumerate() {
            sum[i] += s;
        }
    }
    sum
}

/// Apply true peak limiting via soft clipping.
///
/// Instead of reducing the gain of the entire signal (which kills
/// loudness), this only affects samples near or above the limit.
/// Uses a soft-knee transfer curve that smoothly compresses peaks
/// above the knee threshold while leaving everything below untouched.
fn apply_true_peak_limiter(
    samples: &mut [f32],
    channels: u16,
    limit_dbfs: f64,
) -> bool {
    let true_peak = lufs::true_peak_dbfs(samples, channels);

    if true_peak <= limit_dbfs {
        return false;
    }

    let limit_linear = 10.0_f64.powf(limit_dbfs / 20.0) as f32;
    // Soft knee starts 2 dB below the limit
    let knee_db = 2.0_f32;
    let knee_start = limit_linear * 10.0_f32.powf(-knee_db / 20.0);

    for sample in samples.iter_mut() {
        let abs_val = sample.abs();
        if abs_val <= knee_start {
            // Below knee — no change
            continue;
        }

        let sign = sample.signum();

        if abs_val >= limit_linear {
            // Above limit — hard clip
            *sample = sign * limit_linear;
        } else {
            // In the knee region — smooth compression
            // Map knee_start..limit_linear → knee_start..limit_linear with curve
            let t = (abs_val - knee_start) / (limit_linear - knee_start);
            // Quadratic soft knee: output grows slower as input approaches limit
            let compressed = knee_start + (limit_linear - knee_start) * (2.0 * t - t * t);
            *sample = sign * compressed;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_sine_audio(
        sample_rate: u32,
        freq: f32,
        amplitude: f32,
        duration_secs: f32,
        channels: u16,
    ) -> AudioData {
        let num_frames = (sample_rate as f32 * duration_secs) as usize;
        let mut samples = Vec::with_capacity(num_frames * channels as usize);
        for i in 0..num_frames {
            let t = i as f32 / sample_rate as f32;
            let s = (t * freq * 2.0 * std::f32::consts::PI).sin() * amplitude;
            for _ in 0..channels {
                samples.push(s);
            }
        }
        AudioData {
            samples,
            sample_rate,
            channels,
            bits_per_sample: 16,
        }
    }

    #[test]
    fn test_normalize_reaches_target() {
        let audio = make_sine_audio(44100, 1000.0, 0.5, 5.0, 1);
        let result = normalize(&audio, -14.0, 0.0, -1.0);

        let output_lufs = lufs::measure_lufs(&result.samples, 44100, 1);
        assert!(
            (output_lufs.integrated - (-14.0)).abs() < 0.5,
            "Expected ~-14 LUFS, got {}",
            output_lufs.integrated
        );
    }

    #[test]
    fn test_normalize_reaches_target_with_limiting() {
        // Signal at -14 dBFS boosted to -3 LUFS with -1 dBFS peak limit.
        // +14 dB gain pushes peak to ~0 dBFS, forcing the limiter.
        // Verify both LUFS target and peak limit are met.
        let amplitude = 10.0_f32.powf(-14.0 / 20.0); // -14 dBFS
        let audio = make_sine_audio(44100, 1000.0, amplitude, 5.0, 1);
        let result = normalize(&audio, -3.0, 0.0, -1.0);

        assert!(result.limiter_applied, "Limiter should have engaged");

        let output_lufs = lufs::measure_lufs(&result.samples, 44100, 1);
        assert!(
            (output_lufs.integrated - (-3.0)).abs() < 1.0,
            "Expected ~-3 LUFS after limiting, got {}",
            output_lufs.integrated
        );

        // True peak must respect the limit
        let peak = lufs::true_peak_dbfs(&result.samples, 1);
        assert!(
            peak <= -0.9,
            "Peak should be <= -1 dBFS, got {peak}"
        );
    }

    #[test]
    fn test_normalize_reaches_target_with_tilt_and_limiting() {
        // Combined tilt correction + loudness + limiting
        let audio = make_sine_audio(44100, 200.0, 0.8, 5.0, 1);
        let result = normalize(&audio, -14.0, -3.0, -1.0);

        let output_lufs = lufs::measure_lufs(&result.samples, 44100, 1);
        assert!(
            (output_lufs.integrated - (-14.0)).abs() < 1.0,
            "Expected ~-14 LUFS with tilt+limiting, got {}",
            output_lufs.integrated
        );
    }

    #[test]
    fn test_normalize_quiet_signal() {
        let amplitude = 10.0_f32.powf(-30.0 / 20.0); // -30 dBFS
        let audio = make_sine_audio(44100, 1000.0, amplitude, 5.0, 1);
        let result = normalize(&audio, -14.0, 0.0, -1.0);

        // Should have applied positive gain
        assert!(result.gain_db > 0.0);
    }

    #[test]
    fn test_normalize_loud_signal() {
        let audio = make_sine_audio(44100, 1000.0, 1.0, 5.0, 1);
        let result = normalize(&audio, -14.0, 0.0, -1.0);

        // Should have applied negative gain (attenuation)
        assert!(result.gain_db < 0.0);
    }

    #[test]
    fn test_true_peak_limiting() {
        let audio = make_sine_audio(44100, 1000.0, 1.0, 2.0, 1);
        let result = normalize(&audio, -3.0, 0.0, -1.0);

        // True peak should be at or below -1 dBFS
        let peak = lufs::true_peak_dbfs(&result.samples, 1);
        assert!(
            peak <= -0.9, // small tolerance
            "Peak should be <= -1 dBFS, got {peak}"
        );
    }

    #[test]
    fn test_silence_no_amplification() {
        let audio = make_sine_audio(44100, 1000.0, 0.0, 2.0, 1);
        let result = normalize(&audio, -14.0, 0.0, -1.0);

        // Should not apply extreme gain to silence
        assert!(result.gain_db.abs() < 0.1);
    }

    #[test]
    fn test_stereo_normalize() {
        let audio = make_sine_audio(44100, 1000.0, 0.5, 5.0, 2);
        let result = normalize(&audio, -14.0, 0.0, -1.0);

        let output_lufs = lufs::measure_lufs(&result.samples, 44100, 2);
        assert!(
            (output_lufs.integrated - (-14.0)).abs() < 0.5,
            "Expected ~-14 LUFS, got {}",
            output_lufs.integrated
        );
    }

    #[test]
    fn test_preset_values() {
        assert_eq!(PRESET_BROADCAST.target_lufs, -14.0);
        assert_eq!(PRESET_LIVE_LOUD.target_lufs, -10.0);
        assert_eq!(PRESET_LIVE_WARM.target_lufs, -12.0);
    }

    #[test]
    fn test_with_tilt_correction() {
        let audio = make_sine_audio(44100, 100.0, 0.5, 5.0, 1);
        let result = normalize(&audio, -14.0, -3.0, -1.0);

        // Should have applied some processing
        assert!(result.samples.len() == audio.samples.len());
    }

    /// Make broadband noise with a known tilt for testing.
    fn make_broadband_audio(
        sample_rate: u32,
        duration_secs: f32,
        channels: u16,
    ) -> AudioData {
        // Generate pink-ish noise (negative tilt) using Paul Kellet's filter
        let num_frames = (sample_rate as f32 * duration_secs) as usize;
        let total_samples = num_frames * channels as usize;
        let mut samples = Vec::with_capacity(total_samples);

        // Simple LCG RNG
        let mut state: u64 = 12345;
        let mut b0 = 0.0f64;
        let mut b1 = 0.0f64;
        let mut b2 = 0.0f64;
        let mut b3 = 0.0f64;
        let mut b4 = 0.0f64;
        let mut b5 = 0.0f64;
        let mut b6 = 0.0f64;

        for _ in 0..num_frames {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let white = (state >> 33) as i32 as f32 / (1u32 << 31) as f32;
            let w = white as f64;

            b0 = 0.99886 * b0 + w * 0.0555179;
            b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.96900 * b2 + w * 0.1538520;
            b3 = 0.86650 * b3 + w * 0.3104856;
            b4 = 0.55000 * b4 + w * 0.5329522;
            b5 = -0.7616 * b5 - w * 0.0168980;
            let pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) as f32 * 0.03;
            b6 = w as f64 * 0.115926;

            for _ in 0..channels {
                samples.push(pink);
            }
        }

        AudioData {
            samples,
            sample_rate,
            channels,
            bits_per_sample: 16,
        }
    }

    #[test]
    fn test_correct_audio_stem_workflow() {
        // Simulate the real stem workflow:
        // 1. Measure sum tilt
        // 2. Compute delta = target - sum_tilt
        // 3. Apply delta via correct_audio
        // 4. Verify the corrected signal's tilt moved toward target
        let audio = make_broadband_audio(44100, 5.0, 1);
        let sum_tilt = tilt::measure_tilt(&audio.samples, audio.sample_rate, audio.channels);
        let target_tilt = sum_tilt + 2.0; // shift by +2 dB/oct
        let tilt_delta = target_tilt - sum_tilt; // = +2.0

        // Use high peak limit to avoid limiter interfering with tilt test
        let result = correct_audio(&audio, 0.0, tilt_delta, 20.0);
        let result_tilt = tilt::measure_tilt(&result.samples, audio.sample_rate, audio.channels);

        assert!(
            (result_tilt - target_tilt).abs() < 1.5,
            "After +2 dB/oct correction: expected ~{target_tilt}, got {result_tilt} (was {sum_tilt})"
        );
    }

    #[test]
    fn test_correct_audio_negative_tilt_delta() {
        // Shift tilt by -2 dB/oct (make it bassier)
        let audio = make_broadband_audio(44100, 5.0, 1);
        let sum_tilt = tilt::measure_tilt(&audio.samples, audio.sample_rate, audio.channels);
        let tilt_delta = -2.0;

        // Use high peak limit to avoid limiter interfering with tilt test
        let result = correct_audio(&audio, 0.0, tilt_delta, 20.0);
        let result_tilt = tilt::measure_tilt(&result.samples, audio.sample_rate, audio.channels);

        assert!(
            result_tilt < sum_tilt - 0.5,
            "After -2 dB/oct correction: tilt should decrease. Was {sum_tilt}, got {result_tilt}"
        );
    }

    #[test]
    fn test_correct_audio_gain_only() {
        // Zero tilt, +6 dB gain — use high peak limit to avoid limiter
        let audio = make_broadband_audio(44100, 3.0, 1);
        let result = correct_audio(&audio, 6.0, 0.0, 20.0);

        // Should have applied 6 dB gain
        assert!((result.gain_db - 6.0).abs() < 0.01);

        // Check samples are louder
        let gain_linear = 10.0_f64.powf(6.0 / 20.0) as f32;
        let sample_ratio = result.samples[1000] / audio.samples[1000];
        assert!(
            (sample_ratio - gain_linear).abs() < 0.1,
            "Expected gain ratio ~{gain_linear}, got {sample_ratio}"
        );
    }

    #[test]
    fn test_correct_audio_zero_correction_no_change() {
        // Zero tilt, zero gain — use high peak limit so limiter doesn't engage
        let audio = make_broadband_audio(44100, 3.0, 1);
        let result = correct_audio(&audio, 0.0, 0.0, 20.0);

        let max_diff = audio.samples.iter()
            .zip(result.samples.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_diff < 0.001,
            "Zero correction should not change samples, max diff: {max_diff}"
        );
    }

    #[test]
    fn test_normalize_stems_batch_reaches_target() {
        // Create 3 stems with different frequencies (simulating real stems)
        let stem1 = make_sine_audio(44100, 100.0, 0.3, 5.0, 1); // bass
        let stem2 = make_sine_audio(44100, 1000.0, 0.2, 5.0, 1); // mid
        let stem3 = make_sine_audio(44100, 5000.0, 0.15, 5.0, 1); // treble

        let mut stems = vec![stem1, stem2, stem3];
        let result = normalize_stems_batch(&mut stems, -14.0, 0.0, -1.0);

        // Sum the corrected stems and verify LUFS
        let max_len = stems.iter().map(|s| s.samples.len()).max().unwrap();
        let mut sum = vec![0.0f32; max_len];
        for s in &stems {
            for (i, &v) in s.samples.iter().enumerate() {
                sum[i] += v;
            }
        }

        let sum_lufs = lufs::measure_lufs(&sum, 44100, 1);
        assert!(
            (sum_lufs.integrated - (-14.0)).abs() < 1.0,
            "Sum should be ~-14 LUFS, got {}",
            sum_lufs.integrated
        );

        // Sum peak should respect the limit
        let sum_peak = lufs::true_peak_dbfs(&sum, 1);
        assert!(
            sum_peak <= -0.9,
            "Sum peak should be <= -1 dBFS, got {sum_peak}"
        );
    }

    #[test]
    fn test_normalize_stems_batch_preserves_balance() {
        // Two stems at different levels — their relative balance should be preserved
        let stem_loud = make_sine_audio(44100, 440.0, 0.5, 5.0, 1);
        let stem_quiet = make_sine_audio(44100, 880.0, 0.1, 5.0, 1);

        // Measure original ratio
        let orig_ratio = stem_loud.samples[10000].abs() / stem_quiet.samples[10000].abs();

        let mut stems = vec![stem_loud, stem_quiet];
        let result = normalize_stems_batch(&mut stems, -14.0, 0.0, -1.0);

        // Check that approximately the same gain was applied to both.
        // Some change is expected because tilt correction affects different
        // frequencies differently, but the ratio should stay close.
        let new_ratio = stems[0].samples[10000].abs() / stems[1].samples[10000].abs();
        assert!(
            (new_ratio - orig_ratio).abs() / orig_ratio < 0.1,
            "Balance should be roughly preserved. Original ratio: {orig_ratio}, new: {new_ratio}"
        );
    }
}
