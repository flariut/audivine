//! Spectral tilt measurement and correction.
//!
//! Spectral tilt describes the overall bass-to-treble energy balance,
//! measured in dB/octave. Negative values = more bass, positive = more treble.
//!
//! - Typical mastered music: -3 to -4 dB/oct
//! - Live/broadcast standard: -3.0 dB/oct
//! - "Warm" live mix: -4.5 dB/oct
//!
//! Measurement uses FFT-based power spectrum averaged over overlapping
//! windows, grouped into 1/3-octave bands, then fit with linear regression
//! of dB vs log2(frequency) to get the slope in dB/octave.

use rustfft::{num_complex::Complex, FftPlanner};

const FFT_SIZE: usize = 8192;
const HOP_SIZE: usize = FFT_SIZE / 2; // 50% overlap

/// Measure the spectral tilt of audio in dB/octave.
///
/// Uses FFT-based power spectrum analysis:
/// 1. Compute average power spectrum over overlapping Hann-windowed frames
/// 2. Group into 1/3-octave bands from 50 Hz to Nyquist/2
/// 3. Linear regression of band power (dB) vs frequency (log2)
///    → slope = spectral tilt in dB/octave
pub fn measure_tilt(samples: &[f32], sample_rate: u32, channels: u16) -> f64 {
    let channels = channels as usize;
    if samples.is_empty() || channels == 0 {
        return 0.0;
    }

    let mono = mix_to_mono(samples, channels);

    if mono.len() < FFT_SIZE {
        return 0.0;
    }

    // Step 1: Average power spectrum via overlapping windowed FFTs
    let avg_spectrum = average_power_spectrum(&mono, sample_rate);

    // Step 2: Group into 1/3-octave bands
    let nyquist = sample_rate as f64 / 2.0;
    let bands = third_octave_band_powers(&avg_spectrum, sample_rate, 50.0, nyquist * 0.8);

    if bands.len() < 3 {
        return 0.0;
    }

    // Step 3: Linear regression of dB power vs log2(frequency)
    linear_regression_slope(&bands)
}

/// Compute the loudness-gated average power spectrum.
///
/// Uses a two-pass approach inspired by the EBU R128 gating algorithm:
/// 1. First pass: compute RMS energy per frame
/// 2. Find the mean RMS of all frames → set gate at -10 dB below that
/// 3. Second pass: only include frames above the gate in the average
///
/// This ensures quiet sections (intros, breakdowns, fade-outs) don't
/// dilute the tilt measurement. The tilt reflects the spectral balance
/// of the parts the listener perceives as "loud".
fn average_power_spectrum(mono: &[f32], _sample_rate: u32) -> Vec<f64> {
    let mut planner = FftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    let hann_window: Vec<f64> = (0..FFT_SIZE)
        .map(|i| {
            0.5 * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / FFT_SIZE as f64).cos())
        })
        .collect();

    let spectrum_len = FFT_SIZE / 2 + 1;

    // --- Pass 1: Compute RMS energy and spectrum for each frame ---
    struct FrameData {
        spectrum: Vec<f64>,
        rms_energy: f64,
    }

    let mut frames: Vec<FrameData> = Vec::new();
    let mut pos = 0;

    while pos + FFT_SIZE <= mono.len() {
        // Compute RMS of the raw frame (before windowing)
        let rms_energy: f64 = (0..FFT_SIZE)
            .map(|i| {
                let s = mono[pos + i] as f64;
                s * s
            })
            .sum::<f64>()
            / FFT_SIZE as f64;

        // Window and FFT
        let mut buffer: Vec<Complex<f64>> = (0..FFT_SIZE)
            .map(|i| Complex::new(mono[pos + i] as f64 * hann_window[i], 0.0))
            .collect();

        fft.process(&mut buffer);

        let spectrum: Vec<f64> = buffer.iter().take(spectrum_len).map(|c| c.norm_sqr()).collect();

        frames.push(FrameData { spectrum, rms_energy });
        pos += HOP_SIZE;
    }

    if frames.is_empty() {
        return vec![0.0_f64; spectrum_len];
    }

    // --- Gate threshold: -10 dB below mean RMS ---
    let mean_rms: f64 = frames.iter().map(|f| f.rms_energy).sum::<f64>() / frames.len() as f64;
    // -10 dB in power = factor of 0.1
    let gate_threshold = mean_rms * 0.1;

    // --- Pass 2: Average only loud frames ---
    let mut avg_spectrum = vec![0.0_f64; spectrum_len];
    let mut gated_count = 0u64;

    for frame in &frames {
        if frame.rms_energy >= gate_threshold {
            for (i, &power) in frame.spectrum.iter().enumerate() {
                avg_spectrum[i] += power;
            }
            gated_count += 1;
        }
    }

    // Fallback: if everything is gated out (very quiet signal), use all frames
    if gated_count == 0 {
        for frame in &frames {
            for (i, &power) in frame.spectrum.iter().enumerate() {
                avg_spectrum[i] += power;
            }
        }
        gated_count = frames.len() as u64;
    }

    for val in &mut avg_spectrum {
        *val /= gated_count as f64;
    }

    avg_spectrum
}

/// A frequency band with center frequency and power in dB.
struct BandPower {
    log2_freq: f64,
    power_db: f64,
}

/// Group FFT bins into 1/3-octave bands and return (log2_freq, power_dB) pairs.
fn third_octave_band_powers(
    spectrum: &[f64],
    sample_rate: u32,
    min_freq: f64,
    max_freq: f64,
) -> Vec<BandPower> {
    let bin_width = sample_rate as f64 / FFT_SIZE as f64;
    let spectrum_len = spectrum.len();

    // 1/3-octave bands: each band center is 2^(1/3) apart
    let ratio = 2.0_f64.powf(1.0 / 3.0);
    let half_band = ratio.sqrt(); // half-bandwidth multiplier

    let mut bands = Vec::new();
    let mut center = min_freq;

    while center <= max_freq {
        let low = center / half_band;
        let high = center * half_band;

        let bin_low = (low / bin_width).ceil() as usize;
        let bin_high = (high / bin_width).floor() as usize;

        if bin_low < spectrum_len && bin_high < spectrum_len && bin_high >= bin_low {
            let mut sum = 0.0_f64;
            let mut count = 0u32;
            for i in bin_low..=bin_high {
                sum += spectrum[i];
                count += 1;
            }

            if count > 0 && sum > 0.0 {
                let avg_power = sum / count as f64;
                let power_db = 10.0 * avg_power.log10();
                bands.push(BandPower {
                    log2_freq: center.log2(),
                    power_db,
                });
            }
        }

        center *= ratio;
    }

    bands
}

/// Linear regression of power_dB vs log2_freq.
/// Returns slope in dB/octave.
fn linear_regression_slope(bands: &[BandPower]) -> f64 {
    let n = bands.len() as f64;
    if n < 2.0 {
        return 0.0;
    }

    let sum_x: f64 = bands.iter().map(|b| b.log2_freq).sum();
    let sum_y: f64 = bands.iter().map(|b| b.power_db).sum();
    let sum_xy: f64 = bands.iter().map(|b| b.log2_freq * b.power_db).sum();
    let sum_xx: f64 = bands.iter().map(|b| b.log2_freq * b.log2_freq).sum();

    let denom = n * sum_xx - sum_x * sum_x;
    if denom.abs() < 1e-12 {
        return 0.0;
    }

    (n * sum_xy - sum_x * sum_y) / denom
}

/// Apply spectral tilt correction in the frequency domain.
///
/// Uses overlap-add FFT processing to apply a gain curve that's
/// proportional to log2(frequency). This applies a true tilt —
/// a gradual slope across the whole spectrum — rather than a shelf
/// (which would be a step function that over-boosts the treble).
///
/// The correction gain at each frequency f is:
///   gain_dB(f) = correction_per_oct * log2(f / f_pivot)
///
/// where f_pivot is the geometric center of the analysis range,
/// so frequencies below the pivot are cut and above are boosted
/// (or vice versa), with zero gain at the pivot.
pub fn apply_tilt_correction(
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
    current_tilt: f64,
    target_tilt: f64,
) -> Vec<f32> {
    let correction_per_oct = target_tilt - current_tilt;

    if correction_per_oct.abs() < 0.1 {
        return samples.to_vec();
    }

    let channels_usize = channels as usize;
    let mono = mix_to_mono(samples, channels_usize);

    if mono.len() < FFT_SIZE {
        return samples.to_vec();
    }

    // Pivot frequency: geometric center of the analysis range (50 Hz to ~80% Nyquist)
    let nyquist = sample_rate as f64 / 2.0;
    let f_low = 50.0_f64;
    let f_high = nyquist * 0.8;
    let f_pivot = (f_low * f_high).sqrt();

    // Build the gain curve for each FFT bin
    let bin_width = sample_rate as f64 / FFT_SIZE as f64;
    let spectrum_len = FFT_SIZE / 2 + 1;
    let mut gain_curve = vec![1.0_f64; spectrum_len];

    for i in 1..spectrum_len {
        let freq = i as f64 * bin_width;
        if freq < f_low * 0.5 {
            // Below analysis range — no correction (avoid extreme sub-bass changes)
            continue;
        }
        let octaves_from_pivot = (freq / f_pivot).log2();
        let gain_db = correction_per_oct * octaves_from_pivot;
        // Clamp to avoid extreme gains
        let gain_db = gain_db.clamp(-12.0, 12.0);
        gain_curve[i] = 10.0_f64.powf(gain_db / 20.0);
    }

    // Apply per channel using overlap-add
    let mut output = samples.to_vec();
    for ch in 0..channels_usize {
        // Extract this channel
        let channel_samples: Vec<f32> = (0..mono.len())
            .map(|i| samples[i * channels_usize + ch])
            .collect();

        let corrected = overlap_add_filter(&channel_samples, &gain_curve);

        // Write back
        for (i, &s) in corrected.iter().enumerate() {
            if i * channels_usize + ch < output.len() {
                output[i * channels_usize + ch] = s;
            }
        }
    }

    output
}

/// Apply a frequency-domain gain curve using overlap-add processing.
fn overlap_add_filter(samples: &[f32], gain_curve: &[f64]) -> Vec<f32> {
    use rustfft::num_complex::Complex;
    use rustfft::FftPlanner;

    let mut planner = FftPlanner::<f64>::new();
    let fft_fwd = planner.plan_fft_forward(FFT_SIZE);
    let fft_inv = planner.plan_fft_inverse(FFT_SIZE);

    let hann_window: Vec<f64> = (0..FFT_SIZE)
        .map(|i| {
            0.5 * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / FFT_SIZE as f64).cos())
        })
        .collect();

    let mut output = vec![0.0f64; samples.len()];
    let mut window_sum = vec![0.0f64; samples.len()];

    let spectrum_len = FFT_SIZE / 2 + 1;
    let mut pos = 0;

    while pos + FFT_SIZE <= samples.len() {
        // Window the input frame
        let mut buffer: Vec<Complex<f64>> = (0..FFT_SIZE)
            .map(|i| Complex::new(samples[pos + i] as f64 * hann_window[i], 0.0))
            .collect();

        // Forward FFT
        fft_fwd.process(&mut buffer);

        // Apply gain curve (positive frequencies)
        for i in 0..spectrum_len {
            buffer[i] = buffer[i] * gain_curve[i];
        }
        // Mirror to negative frequencies
        for i in spectrum_len..FFT_SIZE {
            buffer[i] = buffer[FFT_SIZE - i].conj();
        }

        // Inverse FFT
        fft_inv.process(&mut buffer);

        // Overlap-add with synthesis window and normalization
        let norm = 1.0 / FFT_SIZE as f64;
        for i in 0..FFT_SIZE {
            output[pos + i] += buffer[i].re * norm * hann_window[i];
            window_sum[pos + i] += hann_window[i] * hann_window[i];
        }

        pos += HOP_SIZE;
    }

    // Normalize by window sum (avoid division by zero)
    output
        .iter()
        .zip(window_sum.iter())
        .enumerate()
        .map(|(i, (&o, &w))| {
            if w > 1e-10 {
                (o / w) as f32
            } else {
                samples.get(i).copied().unwrap_or(0.0)
            }
        })
        .collect()
}

/// Mix interleaved multi-channel audio to mono.
fn mix_to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels == 1 {
        return samples.to_vec();
    }

    let frames = samples.len() / channels;
    let scale = 1.0 / channels as f32;
    (0..frames)
        .map(|f| {
            let mut sum = 0.0;
            for ch in 0..channels {
                sum += samples[f * channels + ch];
            }
            sum * scale
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Simple LCG pseudo-random number generator (deterministic, no dependencies).
    struct Rng {
        state: u64,
    }

    impl Rng {
        fn new(seed: u64) -> Self {
            Self { state: seed }
        }

        /// Returns a uniform f32 in [-1, 1].
        fn next_f32(&mut self) -> f32 {
            // LCG parameters from Numerical Recipes
            self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            // Use upper bits for quality
            let bits = (self.state >> 33) as i32;
            bits as f32 / (1u32 << 31) as f32
        }
    }

    /// Generate white noise (flat PSD, 0 dB/oct tilt).
    fn make_white_noise(sample_rate: u32, duration_secs: f32) -> Vec<f32> {
        let num_samples = (sample_rate as f32 * duration_secs) as usize;
        let mut rng = Rng::new(42);
        (0..num_samples).map(|_| rng.next_f32() * 0.5).collect()
    }

    /// Generate pink noise (-3 dB/oct PSD) using Paul Kellet's filter method.
    fn make_pink_noise(sample_rate: u32, duration_secs: f32) -> Vec<f32> {
        let num_samples = (sample_rate as f32 * duration_secs) as usize;
        let mut rng = Rng::new(42);

        let mut b0 = 0.0f64;
        let mut b1 = 0.0f64;
        let mut b2 = 0.0f64;
        let mut b3 = 0.0f64;
        let mut b4 = 0.0f64;
        let mut b5 = 0.0f64;
        let mut b6 = 0.0f64;

        let mut output = Vec::with_capacity(num_samples);
        for _ in 0..num_samples {
            let white = rng.next_f32() as f64;
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520;
            b3 = 0.86650 * b3 + white * 0.3104856;
            b4 = 0.55000 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.0168980;
            let pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
            b6 = white * 0.115926;
            output.push(pink as f32 * 0.15); // scale down to avoid clipping
        }

        output
    }

    /// Generate brown noise (-6 dB/oct PSD) via integrated white noise.
    fn make_brown_noise(sample_rate: u32, duration_secs: f32) -> Vec<f32> {
        let num_samples = (sample_rate as f32 * duration_secs) as usize;
        let mut rng = Rng::new(42);
        let mut value = 0.0f32;
        let leak = 0.998; // very slight DC leak to prevent drift

        let mut output = Vec::with_capacity(num_samples);
        for _ in 0..num_samples {
            value = value * leak + rng.next_f32() * 0.1;
            output.push(value);
        }

        // Normalize
        let peak = output.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        if peak > 0.0 {
            let scale = 0.5 / peak;
            for s in &mut output {
                *s *= scale;
            }
        }

        output
    }

    #[test]
    fn test_white_noise_near_zero_tilt() {
        // White noise: flat PSD → ~0 dB/oct
        let signal = make_white_noise(44100, 5.0);
        let tilt = measure_tilt(&signal, 44100, 1);
        assert!(
            tilt.abs() < 1.5,
            "White noise should have tilt near 0 dB/oct, got {tilt}"
        );
    }

    #[test]
    fn test_pink_noise_minus_3_tilt() {
        // Pink noise: -3 dB/oct PSD
        let signal = make_pink_noise(44100, 5.0);
        let tilt = measure_tilt(&signal, 44100, 1);
        assert!(
            tilt > -5.0 && tilt < -1.0,
            "Pink noise should have tilt near -3 dB/oct, got {tilt}"
        );
    }

    #[test]
    fn test_brown_noise_minus_6_tilt() {
        // Brown noise: -6 dB/oct PSD
        let signal = make_brown_noise(44100, 5.0);
        let tilt = measure_tilt(&signal, 44100, 1);
        assert!(
            tilt < -4.0,
            "Brown noise should have tilt near -6 dB/oct (strongly negative), got {tilt}"
        );
    }

    #[test]
    fn test_noise_ordering() {
        // White > Pink > Brown in tilt value
        let white = make_white_noise(44100, 5.0);
        let pink = make_pink_noise(44100, 5.0);
        let brown = make_brown_noise(44100, 5.0);

        let tilt_w = measure_tilt(&white, 44100, 1);
        let tilt_p = measure_tilt(&pink, 44100, 1);
        let tilt_b = measure_tilt(&brown, 44100, 1);

        assert!(
            tilt_w > tilt_p,
            "White ({tilt_w}) should have higher tilt than pink ({tilt_p})"
        );
        assert!(
            tilt_p > tilt_b,
            "Pink ({tilt_p}) should have higher tilt than brown ({tilt_b})"
        );
    }

    #[test]
    fn test_silence_zero_tilt() {
        let silence = vec![0.0f32; 44100 * 2];
        let tilt = measure_tilt(&silence, 44100, 1);
        assert_eq!(tilt, 0.0);
    }

    #[test]
    fn test_tilt_correction_reduces_difference() {
        let signal = make_brown_noise(44100, 3.0);
        let original_tilt = measure_tilt(&signal, 44100, 1);

        let corrected = apply_tilt_correction(&signal, 44100, 1, original_tilt, 0.0);
        let new_tilt = measure_tilt(&corrected, 44100, 1);

        assert!(
            new_tilt.abs() < original_tilt.abs(),
            "Correction should reduce tilt magnitude: {original_tilt} -> {new_tilt}"
        );
    }

    #[test]
    fn test_mix_to_mono() {
        let stereo = vec![1.0, 0.0, 0.0, 1.0]; // L=1,R=0 then L=0,R=1
        let mono = mix_to_mono(&stereo, 2);
        assert_eq!(mono.len(), 2);
        assert!((mono[0] - 0.5).abs() < 0.001);
        assert!((mono[1] - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_short_audio_returns_zero() {
        let short = vec![0.5f32; 100];
        let tilt = measure_tilt(&short, 44100, 1);
        assert_eq!(tilt, 0.0);
    }

    #[test]
    fn test_stereo_same_as_mono() {
        let signal = make_pink_noise(44100, 3.0);
        let tilt_mono = measure_tilt(&signal, 44100, 1);

        let stereo: Vec<f32> = signal.iter().flat_map(|&s| [s, s]).collect();
        let tilt_stereo = measure_tilt(&stereo, 44100, 2);

        assert!(
            (tilt_mono - tilt_stereo).abs() < 0.5,
            "Mono and stereo of same content should give similar tilt: {tilt_mono} vs {tilt_stereo}"
        );
    }

    // --- Tilt correction accuracy tests ---

    #[test]
    fn test_correction_brown_to_minus_3() {
        // Brown noise (~-6 dB/oct) corrected to -3 dB/oct
        let signal = make_brown_noise(44100, 5.0);
        let original = measure_tilt(&signal, 44100, 1);
        let target = -3.0;

        let corrected = apply_tilt_correction(&signal, 44100, 1, original, target);
        let result = measure_tilt(&corrected, 44100, 1);

        assert!(
            (result - target).abs() < 1.0,
            "Brown→-3: expected ~{target}, got {result} (was {original})"
        );
    }

    #[test]
    fn test_correction_brown_to_zero() {
        // Brown noise (~-6 dB/oct) corrected to 0 dB/oct is an extreme correction
        // (~6 dB/oct shift). The ±12 dB gain clamp limits how far we can go.
        // Verify it moves significantly toward the target.
        let signal = make_brown_noise(44100, 5.0);
        let original = measure_tilt(&signal, 44100, 1);
        let target = 0.0;

        let corrected = apply_tilt_correction(&signal, 44100, 1, original, target);
        let result = measure_tilt(&corrected, 44100, 1);

        // Should correct at least half the distance
        let improvement = (original - target).abs() - (result - target).abs();
        assert!(
            improvement > (original - target).abs() * 0.5,
            "Brown→0: should correct >50% of error. Was {original}, got {result}, target {target}"
        );
    }

    #[test]
    fn test_correction_white_to_minus_3() {
        // White noise (~0 dB/oct) corrected to -3 dB/oct
        let signal = make_white_noise(44100, 5.0);
        let original = measure_tilt(&signal, 44100, 1);
        let target = -3.0;

        let corrected = apply_tilt_correction(&signal, 44100, 1, original, target);
        let result = measure_tilt(&corrected, 44100, 1);

        assert!(
            (result - target).abs() < 1.0,
            "White→-3: expected ~{target}, got {result} (was {original})"
        );
    }

    #[test]
    fn test_correction_pink_to_minus_4_5() {
        // Pink noise (~-3 dB/oct) corrected to -4.5 dB/oct (warm preset)
        let signal = make_pink_noise(44100, 5.0);
        let original = measure_tilt(&signal, 44100, 1);
        let target = -4.5;

        let corrected = apply_tilt_correction(&signal, 44100, 1, original, target);
        let result = measure_tilt(&corrected, 44100, 1);

        assert!(
            (result - target).abs() < 1.0,
            "Pink→-4.5: expected ~{target}, got {result} (was {original})"
        );
    }

    #[test]
    fn test_correction_small_adjustment() {
        // Pink noise corrected from ~-3 to -2 (small 1 dB/oct shift)
        let signal = make_pink_noise(44100, 5.0);
        let original = measure_tilt(&signal, 44100, 1);
        let target = original + 1.0;

        let corrected = apply_tilt_correction(&signal, 44100, 1, original, target);
        let result = measure_tilt(&corrected, 44100, 1);

        assert!(
            (result - target).abs() < 0.5,
            "Small shift: expected ~{target}, got {result} (was {original})"
        );
    }

    #[test]
    fn test_correction_no_change_when_on_target() {
        // If already at target, output should be nearly identical
        let signal = make_pink_noise(44100, 5.0);
        let original = measure_tilt(&signal, 44100, 1);

        let corrected = apply_tilt_correction(&signal, 44100, 1, original, original);

        // Samples should be unchanged (no filter applied)
        let max_diff = signal
            .iter()
            .zip(corrected.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_diff < 0.001,
            "No correction needed but samples changed by {max_diff}"
        );
    }
}
