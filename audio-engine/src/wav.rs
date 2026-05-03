//! Audio decoding (WAV, FLAC, AIFF) and WAV encoding.
//!
//! All audio is converted to interleaved f32 samples internally,
//! regardless of the source format or bit depth.
//! Output is always WAV via the `hound` crate.

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use std::io::Cursor;

/// Decoded audio data — interleaved f32 samples.
pub struct AudioData {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
}

impl AudioData {
    /// Duration in seconds.
    pub fn duration_secs(&self) -> f64 {
        let frames = self.samples.len() as f64 / self.channels as f64;
        frames / self.sample_rate as f64
    }

    /// Total sample count (frames × channels).
    pub fn sample_count(&self) -> u64 {
        self.samples.len() as u64
    }
}

/// Decode a WAV file from bytes into interleaved f32 samples.
pub fn decode_wav(data: &[u8]) -> Result<AudioData, String> {
    let reader = WavReader::new(Cursor::new(data))
        .map_err(|e| format!("Invalid WAV file: {e}"))?;

    let spec = reader.spec();
    let channels = spec.channels;
    let sample_rate = spec.sample_rate;
    let bits_per_sample = spec.bits_per_sample;

    let samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Int => {
            let max_val = (1i64 << (bits_per_sample - 1)) as f32;
            reader
                .into_samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max_val))
                .collect::<Result<Vec<f32>, _>>()
                .map_err(|e| format!("Error reading WAV samples: {e}"))?
        }
        SampleFormat::Float => {
            reader
                .into_samples::<f32>()
                .collect::<Result<Vec<f32>, _>>()
                .map_err(|e| format!("Error reading WAV samples: {e}"))?
        }
    };

    if samples.is_empty() {
        return Err("WAV file contains no audio data".to_string());
    }

    Ok(AudioData {
        samples,
        sample_rate,
        channels,
        bits_per_sample,
    })
}

/// Auto-detect audio format and decode to interleaved f32 samples.
///
/// Supports WAV, FLAC, and AIFF. Format is detected by magic bytes.
pub fn decode_audio(data: &[u8]) -> Result<AudioData, String> {
    if data.len() < 12 {
        return Err("File too small to identify audio format".to_string());
    }

    // WAV: "RIFF" ... "WAVE"
    if &data[0..4] == b"RIFF" && &data[8..12] == b"WAVE" {
        return decode_wav(data);
    }
    // AIFF: "FORM" ... "AIFF" or "AIFC"
    if &data[0..4] == b"FORM" && (&data[8..12] == b"AIFF" || &data[8..12] == b"AIFC") {
        return decode_aiff(data);
    }
    // FLAC: "fLaC"
    if &data[0..4] == b"fLaC" {
        return decode_flac(data);
    }

    Err("Unsupported audio format (expected WAV, AIFF, or FLAC)".to_string())
}

/// Decode a FLAC file from bytes into interleaved f32 samples.
pub fn decode_flac(data: &[u8]) -> Result<AudioData, String> {
    let mut reader = claxon::FlacReader::new(Cursor::new(data))
        .map_err(|e| format!("Invalid FLAC file: {e}"))?;

    let info = reader.streaminfo();
    let channels = info.channels as u16;
    let sample_rate = info.sample_rate;
    let bits_per_sample = info.bits_per_sample as u16;
    let max_val = (1i64 << (bits_per_sample - 1)) as f32;

    let mut samples = Vec::new();
    let mut frame_reader = reader.blocks();
    let mut buffer = Vec::new();

    while let Some(block) = frame_reader.read_next_or_eof(buffer)
        .map_err(|e| format!("Error reading FLAC block: {e}"))?
    {
        let n_frames = block.len() as usize;
        let n_channels = block.channels() as usize;
        // claxon stores samples per-channel; we need interleaved
        for frame in 0..n_frames {
            for ch in 0..n_channels {
                let sample = block.sample(ch as u32, frame as u32);
                samples.push(sample as f32 / max_val);
            }
        }
        buffer = block.into_buffer();
    }

    if samples.is_empty() {
        return Err("FLAC file contains no audio data".to_string());
    }

    Ok(AudioData {
        samples,
        sample_rate,
        channels,
        bits_per_sample,
    })
}

/// Decode an AIFF file from bytes into interleaved f32 samples.
///
/// Parses the FORM/COMM/SSND chunk structure manually.
/// Supports 8, 16, and 24-bit big-endian PCM.
pub fn decode_aiff(data: &[u8]) -> Result<AudioData, String> {
    if data.len() < 12 {
        return Err("AIFF file too small".to_string());
    }

    let mut channels: u16 = 0;
    let mut sample_rate: u32 = 0;
    let mut bits_per_sample: u16 = 0;
    let mut num_frames: u32 = 0;
    let mut ssnd_data: &[u8] = &[];

    let mut is_float32 = false;
    let mut is_little_endian = false;

    // Skip FORM header (12 bytes: "FORM" + size + "AIFF"/"AIFC")
    let mut pos = 12;

    while pos + 8 <= data.len() {
        let chunk_id = &data[pos..pos + 4];
        let chunk_size = u32::from_be_bytes([
            data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7],
        ]) as usize;
        let chunk_start = pos + 8;

        if chunk_id == b"COMM" {
            if chunk_start + 18 > data.len() {
                return Err("COMM chunk too small".to_string());
            }
            channels = u16::from_be_bytes([data[chunk_start], data[chunk_start + 1]]);
            num_frames = u32::from_be_bytes([
                data[chunk_start + 2], data[chunk_start + 3],
                data[chunk_start + 4], data[chunk_start + 5],
            ]);
            bits_per_sample = u16::from_be_bytes([data[chunk_start + 6], data[chunk_start + 7]]);
            // Sample rate is 80-bit IEEE 754 extended at offset 8
            sample_rate = extended_to_u32(&data[chunk_start + 8..chunk_start + 18]);

            // If it's AIFC, there might be a compression type
            if chunk_size >= 22 {
                let comp_type = &data[chunk_start + 18..chunk_start + 22];
                if comp_type == b"fl32" || comp_type == b"FL32" {
                    is_float32 = true;
                } else if comp_type == b"sowt" {
                    is_little_endian = true;
                } else if comp_type != b"NONE" && comp_type != b"twos" {
                    return Err(format!("Unsupported AIFC compression: {}", String::from_utf8_lossy(comp_type)));
                }
            }
        } else if chunk_id == b"SSND" {
            if chunk_start + 8 > data.len() {
                return Err("SSND chunk too small".to_string());
            }
            let offset = u32::from_be_bytes([
                data[chunk_start], data[chunk_start + 1],
                data[chunk_start + 2], data[chunk_start + 3],
            ]) as usize;
            // Skip 8 bytes (offset + blockSize fields), then skip `offset` bytes
            let pcm_start = chunk_start + 8 + offset;
            if pcm_start <= data.len() {
                let pcm_end = (chunk_start + chunk_size).min(data.len());
                ssnd_data = &data[pcm_start..pcm_end];
            }
        }

        // Advance to next chunk (chunks are 2-byte aligned)
        pos = chunk_start + chunk_size;
        if chunk_size % 2 != 0 {
            pos += 1;
        }
    }

    if channels == 0 || sample_rate == 0 || bits_per_sample == 0 {
        return Err("AIFF file missing COMM chunk".to_string());
    }
    if ssnd_data.is_empty() {
        return Err("AIFF file missing SSND chunk".to_string());
    }

    let bytes_per_sample = (bits_per_sample as usize + 7) / 8;
    let total_samples = num_frames as usize * channels as usize;
    let max_val = (1i64 << (bits_per_sample - 1)) as f32;
    let mut samples = Vec::with_capacity(total_samples);

    for i in 0..total_samples {
        let offset = i * bytes_per_sample;
        if offset + bytes_per_sample > ssnd_data.len() {
            break;
        }

        if is_float32 && bytes_per_sample == 4 {
            let fval = f32::from_be_bytes([
                ssnd_data[offset], ssnd_data[offset + 1],
                ssnd_data[offset + 2], ssnd_data[offset + 3],
            ]);
            samples.push(fval);
            continue;
        }

        let int_val: i32 = match bytes_per_sample {
            1 => (ssnd_data[offset] as i8) as i32,
            2 => if is_little_endian {
                i16::from_le_bytes([ssnd_data[offset], ssnd_data[offset + 1]]) as i32
            } else {
                i16::from_be_bytes([ssnd_data[offset], ssnd_data[offset + 1]]) as i32
            },
            3 => {
                if is_little_endian {
                    let lo = ssnd_data[offset] as i32;
                    let mid = ssnd_data[offset + 1] as i32;
                    let hi = ssnd_data[offset + 2] as i32;
                    let val = (hi << 16) | (mid << 8) | lo;
                    if val & 0x800000 != 0 { val | !0xFFFFFF } else { val }
                } else {
                    let hi = ssnd_data[offset] as i32;
                    let mid = ssnd_data[offset + 1] as i32;
                    let lo = ssnd_data[offset + 2] as i32;
                    let val = (hi << 16) | (mid << 8) | lo;
                    if val & 0x800000 != 0 { val | !0xFFFFFF } else { val }
                }
            }
            4 => if is_little_endian {
                i32::from_le_bytes([
                    ssnd_data[offset], ssnd_data[offset + 1],
                    ssnd_data[offset + 2], ssnd_data[offset + 3],
                ])
            } else {
                i32::from_be_bytes([
                    ssnd_data[offset], ssnd_data[offset + 1],
                    ssnd_data[offset + 2], ssnd_data[offset + 3],
                ])
            },
            _ => return Err(format!("Unsupported AIFF bit depth: {bits_per_sample}")),
        };

        samples.push(int_val as f32 / max_val);
    }

    if samples.is_empty() {
        return Err("AIFF file contains no audio data".to_string());
    }

    Ok(AudioData {
        samples,
        sample_rate,
        channels,
        bits_per_sample,
    })
}

/// Convert 80-bit IEEE 754 extended precision float to u32.
///
/// AIFF stores sample rate as 80-bit extended. We only need integer
/// rates (44100, 48000, etc.) so this extracts the value as u32.
fn extended_to_u32(bytes: &[u8]) -> u32 {
    let sign = (bytes[0] >> 7) & 1;
    let exponent = (((bytes[0] & 0x7F) as u16) << 8) | bytes[1] as u16;
    let mantissa = u64::from_be_bytes([
        bytes[2], bytes[3], bytes[4], bytes[5],
        bytes[6], bytes[7], bytes[8], bytes[9],
    ]);

    if exponent == 0 && mantissa == 0 {
        return 0;
    }

    // Bias for 80-bit extended is 16383
    let exp = exponent as i32 - 16383;
    // The mantissa has an explicit integer bit (bit 63)
    let val = (mantissa as f64) / (1u64 << 63) as f64 * 2.0_f64.powi(exp);

    if sign == 1 { 0 } else { val as u32 }
}

/// Encode interleaved f32 samples into WAV bytes.
pub fn encode_wav(
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
) -> Result<Vec<u8>, String> {
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample,
        sample_format: if bits_per_sample == 32 {
            SampleFormat::Float
        } else {
            SampleFormat::Int
        },
    };

    let mut buffer = Vec::new();
    {
        let cursor = Cursor::new(&mut buffer);
        let mut writer = WavWriter::new(cursor, spec)
            .map_err(|e| format!("Error creating WAV writer: {e}"))?;

        match spec.sample_format {
            SampleFormat::Float => {
                for &sample in samples {
                    writer.write_sample(sample)
                        .map_err(|e| format!("Error writing sample: {e}"))?;
                }
            }
            SampleFormat::Int => {
                let max_val = (1i64 << (bits_per_sample - 1)) as f32;
                for &sample in samples {
                    let clamped = sample.clamp(-1.0, 1.0);
                    let int_sample = (clamped * max_val) as i32;
                    writer.write_sample(int_sample)
                        .map_err(|e| format!("Error writing sample: {e}"))?;
                }
            }
        }

        writer.finalize()
            .map_err(|e| format!("Error finalizing WAV: {e}"))?;
    }

    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_sine_wav(sample_rate: u32, channels: u16, duration_secs: f32) -> Vec<u8> {
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut buf = Vec::new();
        {
            let cursor = Cursor::new(&mut buf);
            let mut writer = WavWriter::new(cursor, spec).unwrap();
            let num_samples = (sample_rate as f32 * duration_secs) as usize;
            for i in 0..num_samples {
                let t = i as f32 / sample_rate as f32;
                let sample = (t * 440.0 * 2.0 * std::f32::consts::PI).sin() * 0.5;
                for _ in 0..channels {
                    writer.write_sample((sample * 32767.0) as i16).unwrap();
                }
            }
            writer.finalize().unwrap();
        }
        buf
    }

    #[test]
    fn test_decode_16bit_mono() {
        let wav = make_sine_wav(44100, 1, 0.1);
        let audio = decode_wav(&wav).unwrap();
        assert_eq!(audio.sample_rate, 44100);
        assert_eq!(audio.channels, 1);
        assert_eq!(audio.bits_per_sample, 16);
        assert!(audio.duration_secs() > 0.09);
    }

    #[test]
    fn test_decode_16bit_stereo() {
        let wav = make_sine_wav(48000, 2, 0.1);
        let audio = decode_wav(&wav).unwrap();
        assert_eq!(audio.sample_rate, 48000);
        assert_eq!(audio.channels, 2);
    }

    #[test]
    fn test_roundtrip() {
        let wav = make_sine_wav(44100, 2, 0.1);
        let audio = decode_wav(&wav).unwrap();
        let encoded = encode_wav(&audio.samples, audio.sample_rate, audio.channels, 16).unwrap();
        let audio2 = decode_wav(&encoded).unwrap();
        assert_eq!(audio.sample_rate, audio2.sample_rate);
        assert_eq!(audio.channels, audio2.channels);
        assert_eq!(audio.samples.len(), audio2.samples.len());
    }

    #[test]
    fn test_empty_wav_error() {
        assert!(decode_wav(b"not a wav file").is_err());
    }
}
