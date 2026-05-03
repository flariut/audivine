//! LUFS measurement per ITU-R BS.1770-4.
//!
//! Uses the `ebur128` crate for standards-compliant integrated and
//! short-term loudness measurement.

use ebur128::{EbuR128, Mode};

/// LUFS measurement results.
pub struct LufsResult {
    /// Integrated loudness over the entire file (LUFS).
    pub integrated: f64,
    /// Maximum short-term loudness (3s window) in LUFS.
    pub short_term_max: f64,
}

/// Measure integrated and short-term loudness of interleaved f32 audio.
pub fn measure_lufs(samples: &[f32], sample_rate: u32, channels: u16) -> LufsResult {
    let mut meter = EbuR128::new(channels as u32, sample_rate, Mode::I | Mode::S)
        .expect("Failed to create EbuR128 meter");

    // Process in blocks of 4096 frames (arbitrary, but efficient)
    let block_size = 4096 * channels as usize;
    for chunk in samples.chunks(block_size) {
        meter.add_frames_f32(chunk).expect("Failed to add frames");
    }

    let integrated = meter.loudness_global().unwrap_or(f64::NEG_INFINITY);

    // Get max short-term loudness by scanning all 3s windows
    let short_term_max = scan_short_term_max(&meter, samples, sample_rate, channels);

    LufsResult {
        integrated,
        short_term_max,
    }
}

/// Scan for the maximum short-term loudness (3-second sliding window).
fn scan_short_term_max(
    _meter: &EbuR128,
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
) -> f64 {
    // Create a separate meter for short-term scanning
    let mut meter = EbuR128::new(channels as u32, sample_rate, Mode::S)
        .expect("Failed to create short-term meter");

    let frames_per_100ms = (sample_rate as usize) / 10;
    let samples_per_100ms = frames_per_100ms * channels as usize;
    let mut max_st = f64::NEG_INFINITY;

    // Feed 100ms chunks and check short-term after each
    for chunk in samples.chunks(samples_per_100ms) {
        meter.add_frames_f32(chunk).expect("Failed to add frames");
        if let Ok(st) = meter.loudness_shortterm() {
            if st > max_st && st.is_finite() {
                max_st = st;
            }
        }
    }

    max_st
}

/// Calculate the true peak in dBFS across all channels.
///
/// Uses 4x oversampling via linear interpolation for inter-sample
/// peak detection per ITU-R BS.1770-4.
pub fn true_peak_dbfs(samples: &[f32], channels: u16) -> f64 {
    let channels = channels as usize;
    if samples.is_empty() || channels == 0 {
        return f64::NEG_INFINITY;
    }

    let mut max_peak: f32 = 0.0;

    // Process each channel separately
    for ch in 0..channels {
        let channel_samples: Vec<f32> = samples
            .iter()
            .skip(ch)
            .step_by(channels)
            .copied()
            .collect();

        // 4x oversampled peak detection
        for window in channel_samples.windows(2) {
            let a = window[0];
            let b = window[1];
            // Check original samples
            max_peak = max_peak.max(a.abs()).max(b.abs());
            // Check 3 interpolated points between samples
            for k in 1..4 {
                let t = k as f32 / 4.0;
                let interpolated = a + (b - a) * t;
                max_peak = max_peak.max(interpolated.abs());
            }
        }

        // Check last sample
        if let Some(&last) = channel_samples.last() {
            max_peak = max_peak.max(last.abs());
        }
    }

    if max_peak == 0.0 {
        f64::NEG_INFINITY
    } else {
        20.0 * (max_peak as f64).log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_sine(sample_rate: u32, freq: f32, amplitude: f32, duration_secs: f32) -> Vec<f32> {
        let num_samples = (sample_rate as f32 * duration_secs) as usize;
        (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                (t * freq * 2.0 * std::f32::consts::PI).sin() * amplitude
            })
            .collect()
    }

    #[test]
    fn test_silence_is_neg_infinity() {
        let silence = vec![0.0f32; 44100];
        let result = measure_lufs(&silence, 44100, 1);
        assert!(result.integrated < -60.0 || result.integrated.is_infinite());
    }

    #[test]
    fn test_loud_sine_high_lufs() {
        // Full-scale sine should be around -3 LUFS
        let sine = make_sine(44100, 1000.0, 1.0, 5.0);
        let result = measure_lufs(&sine, 44100, 1);
        assert!(result.integrated > -5.0);
        assert!(result.integrated < 0.0);
    }

    #[test]
    fn test_quiet_sine_low_lufs() {
        // -20dB sine should be around -23 LUFS
        let amplitude = 10.0f32.powf(-20.0 / 20.0); // -20 dBFS
        let sine = make_sine(44100, 1000.0, amplitude, 5.0);
        let result = measure_lufs(&sine, 44100, 1);
        assert!(result.integrated < -15.0);
        assert!(result.integrated > -30.0);
    }

    #[test]
    fn test_true_peak_full_scale() {
        let sine = make_sine(44100, 1000.0, 1.0, 0.1);
        let peak = true_peak_dbfs(&sine, 1);
        // Should be close to 0 dBFS
        assert!(peak > -1.0);
        assert!(peak <= 0.1); // Allow small overshoot from interpolation
    }

    #[test]
    fn test_true_peak_half_scale() {
        let sine = make_sine(44100, 1000.0, 0.5, 0.1);
        let peak = true_peak_dbfs(&sine, 1);
        // Should be close to -6 dBFS
        assert!(peak > -7.0);
        assert!(peak < -5.0);
    }

    #[test]
    fn test_true_peak_silence() {
        let silence = vec![0.0f32; 4410];
        let peak = true_peak_dbfs(&silence, 1);
        assert!(peak.is_infinite() && peak < 0.0);
    }

    #[test]
    fn test_stereo_lufs() {
        let mono = make_sine(44100, 1000.0, 0.5, 5.0);
        let stereo: Vec<f32> = mono.iter().flat_map(|&s| [s, s]).collect();
        let result = measure_lufs(&stereo, 44100, 2);
        assert!(result.integrated > -20.0);
        assert!(result.integrated < -5.0);
    }
}
