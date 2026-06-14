use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, SampleRate, SupportedStreamConfig};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use handy_keys::{Hotkey, HotkeyManager, HotkeyState};
use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use transcribe_rs::onnx::parakeet::ParakeetModel;
use transcribe_rs::onnx::Quantization;
use transcribe_rs::{SpeechModel, TranscribeOptions};

#[derive(Default)]
struct CaptureSummary {
    sample_rate: u32,
    duration_ms: u64,
    samples: usize,
    rms: f32,
    peak: f32,
    wav_path: Option<String>,
}

struct TranscriptionSummary {
    text: String,
    language: Option<String>,
    segment_count: usize,
    samples: usize,
}

struct ActiveRecording {
    stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    started_at: Instant,
    wav_path: PathBuf,
    _level_emitter: LevelEmitter,
}

const VISUALIZER_DB_MIN: f32 = -55.0;
const VISUALIZER_DB_MAX: f32 = -8.0;
const VISUALIZER_GAIN: f32 = 1.3;
const VISUALIZER_CURVE_POWER: f32 = 0.7;

struct AudioVisualiser {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    bucket_ranges: Vec<(usize, usize)>,
    fft_input: Vec<Complex32>,
    noise_floor: Vec<f32>,
    buffer: Vec<f32>,
    window_size: usize,
    buckets: usize,
}

impl AudioVisualiser {
    fn new(
        sample_rate: u32,
        window_size: usize,
        buckets: usize,
        freq_min: f32,
        freq_max: f32,
    ) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(window_size);
        let window = (0..window_size)
            .map(|i| {
                0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / window_size as f32).cos())
            })
            .collect();
        let nyquist = sample_rate as f32 / 2.0;
        let freq_min = freq_min.min(nyquist);
        let freq_max = freq_max.min(nyquist);
        let mut bucket_ranges = Vec::with_capacity(buckets);
        for b in 0..buckets {
            let log_start = (b as f32 / buckets as f32).powi(2);
            let log_end = ((b + 1) as f32 / buckets as f32).powi(2);
            let start_hz = freq_min + (freq_max - freq_min) * log_start;
            let end_hz = freq_min + (freq_max - freq_min) * log_end;
            let start_bin = ((start_hz * window_size as f32) / sample_rate as f32) as usize;
            let mut end_bin = ((end_hz * window_size as f32) / sample_rate as f32) as usize;
            if end_bin <= start_bin {
                end_bin = start_bin + 1;
            }
            bucket_ranges.push((start_bin.min(window_size / 2), end_bin.min(window_size / 2)));
        }
        Self {
            fft,
            window,
            bucket_ranges,
            fft_input: vec![Complex32::new(0.0, 0.0); window_size],
            noise_floor: vec![-40.0; buckets],
            buffer: Vec::with_capacity(window_size * 2),
            window_size,
            buckets,
        }
    }

    fn feed(&mut self, samples: &[f32]) -> Option<Vec<f32>> {
        self.buffer.extend_from_slice(samples);
        if self.buffer.len() < self.window_size {
            return None;
        }
        let window_samples = &self.buffer[..self.window_size];
        let mean = window_samples.iter().sum::<f32>() / self.window_size as f32;
        for (i, &sample) in window_samples.iter().enumerate() {
            self.fft_input[i] = Complex32::new((sample - mean) * self.window[i], 0.0);
        }
        self.fft.process(&mut self.fft_input);

        let mut buckets = vec![0.0; self.buckets];
        for (bucket_idx, &(start_bin, end_bin)) in self.bucket_ranges.iter().enumerate() {
            if start_bin >= end_bin || end_bin > self.fft_input.len() / 2 {
                continue;
            }
            let power_sum = (start_bin..end_bin)
                .map(|bin_idx| {
                    let magnitude = self.fft_input[bin_idx].norm();
                    magnitude * magnitude
                })
                .sum::<f32>();
            let avg_power = power_sum / (end_bin - start_bin) as f32;
            let db = if avg_power > 1e-12 {
                20.0 * (avg_power.sqrt() / self.window_size as f32).log10()
            } else {
                -80.0
            };
            if db < self.noise_floor[bucket_idx] + 10.0 {
                const NOISE_ALPHA: f32 = 0.001;
                self.noise_floor[bucket_idx] =
                    NOISE_ALPHA * db + (1.0 - NOISE_ALPHA) * self.noise_floor[bucket_idx];
            }
            let normalized = ((db - VISUALIZER_DB_MIN) / (VISUALIZER_DB_MAX - VISUALIZER_DB_MIN))
                .clamp(0.0, 1.0);
            buckets[bucket_idx] = (normalized * VISUALIZER_GAIN)
                .powf(VISUALIZER_CURVE_POWER)
                .clamp(0.0, 1.0);
        }
        for i in 1..buckets.len().saturating_sub(1) {
            buckets[i] = buckets[i] * 0.7 + buckets[i - 1] * 0.15 + buckets[i + 1] * 0.15;
        }
        self.buffer.clear();
        Some(buckets)
    }
}

struct LevelEmitter {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl LevelEmitter {
    fn start(sample_rate: u32, samples: Arc<Mutex<Vec<f32>>>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let thread = thread::spawn(move || {
            let mut visualizer = AudioVisualiser::new(sample_rate, 1024, 16, 80.0, 8000.0);
            let mut cursor = 0usize;
            while !stop_for_thread.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(60));
                let chunk = match samples.lock() {
                    Ok(guard) if cursor < guard.len() => {
                        let next = guard[cursor..].to_vec();
                        cursor = guard.len();
                        next
                    }
                    _ => Vec::new(),
                };
                if chunk.is_empty() {
                    continue;
                }
                if let Some(levels) = visualizer.feed(&chunk) {
                    let payload = levels
                        .iter()
                        .map(|level| format_float(*level))
                        .collect::<Vec<_>>()
                        .join(",");
                    println!("{{\"ok\":true,\"event\":\"mic-level\",\"levels\":[{payload}]}}");
                    let _ = io::stdout().flush();
                }
            }
        });
        Self {
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for LevelEmitter {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Default)]
struct RecorderDaemon {
    active: Option<ActiveRecording>,
}

fn main() {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        run_json_lines();
        return;
    }

    let command = args.remove(0);
    let result = match command.as_str() {
        "--status" | "status" => status_json(),
        "--devices" | "devices" => devices_json(),
        "--test-microphone" | "test-microphone" => {
            let duration_ms = arg_u64(&args, "--duration-ms").unwrap_or(900);
            capture_json(duration_ms, None)
        }
        "--record" | "record" => {
            let duration_ms = arg_u64(&args, "--duration-ms").unwrap_or(3_000);
            let output = arg_value(&args, "--output").map(PathBuf::from);
            capture_json(duration_ms, output)
        }
        "--transcribe" | "transcribe" => {
            let input = arg_value(&args, "--input").map(PathBuf::from);
            let model = arg_value(&args, "--model").map(PathBuf::from);
            let language = arg_value(&args, "--language");
            transcribe_json(input, model, &language)
        }
        "--paste" | "paste" => paste_json(),
        "--validate-shortcut" | "validate-shortcut" => {
            let shortcut = arg_value(&args, "--shortcut").or_else(|| args.first().cloned());
            validate_shortcut_json(shortcut)
        }
        "--watch-shortcut" | "watch-shortcut" => {
            let shortcut = arg_value(&args, "--shortcut").or_else(|| args.first().cloned());
            watch_shortcut(shortcut)
        }
        "--start" | "start" => Ok(ok_json("recording-started")),
        "--stop" | "stop" => Ok(ok_json("recording-stopped")),
        "--cancel" | "cancel" => Ok(ok_json("recording-cancelled")),
        "--set-shortcut" | "set-shortcut" => {
            let shortcut = json_escape(args.first().map(String::as_str).unwrap_or(""));
            Ok(format!(
                "{{\"ok\":true,\"event\":\"shortcut-updated\",\"shortcut\":\"{}\"}}",
                shortcut
            ))
        }
        "--help" | "help" => Ok(help_text()),
        _ => Err(format!("unknown command: {command}")),
    };

    match result {
        Ok(json) => println!("{json}"),
        Err(error) => {
            println!("{{\"ok\":false,\"error\":\"{}\"}}", json_escape(&error));
            std::process::exit(1);
        }
    }
}

fn run_json_lines() {
    let mut daemon = RecorderDaemon::default();
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let command = line.trim();
        let payload =
            serde_json::from_str::<serde_json::Value>(command).unwrap_or(serde_json::Value::Null);
        let command_name = payload
            .get("command")
            .and_then(|value| value.as_str())
            .unwrap_or(command);
        let output = if command.contains("\"command\":\"status\"") {
            status_json()
        } else if command.contains("\"command\":\"devices\"") {
            devices_json()
        } else if command.contains("\"command\":\"test-microphone\"") {
            capture_json(900, None)
        } else if command_name == "start" {
            let output = payload
                .get("output")
                .and_then(|value| value.as_str())
                .map(PathBuf::from)
                .unwrap_or_else(default_recording_path);
            daemon.start(output)
        } else if command_name == "stop" {
            let model = payload
                .get("model")
                .and_then(|value| value.as_str())
                .map(PathBuf::from);
            let language = payload
                .get("language")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            daemon.stop(model, language)
        } else if command_name == "cancel" {
            daemon.cancel()
        } else if command_name == "paste" {
            paste_json()
        } else {
            Ok(ok_json("noop"))
        };
        println!("{}", output.unwrap_or_else(error_json));
        let _ = io::stdout().flush();
    }
}

fn status_json() -> Result<String, String> {
    let host = cpal::default_host();
    let default_input = host.default_input_device();
    let audio_probe = default_input
        .as_ref()
        .map(input_config_for_device)
        .transpose();
    let ready = audio_probe.is_ok() && default_input.is_some();
    let device = default_input
        .as_ref()
        .and_then(|d| d.name().ok())
        .unwrap_or_else(|| "".to_string());
    let audio_error = audio_probe.err();
    Ok(format!(
        "{{\"ok\":true,\"ready\":{},\"engine\":\"bridge-voice\",\"version\":\"{}\",\"audioReady\":{},\"audioError\":{},\"transcriptionReady\":true,\"defaultInput\":\"{}\",\"defaultVoiceModel\":\"parakeet-tdt-0.6b-v3-int8\",\"features\":[\"devices\",\"microphone-test\",\"wav-recording\",\"parakeet-transcription\",\"shortcut-config\",\"handy-keys\"]}}",
        ready,
        env!("CARGO_PKG_VERSION"),
        ready,
        audio_error
            .as_ref()
            .map(|error| format!("\"{}\"", json_escape(error)))
            .unwrap_or_else(|| "null".to_string()),
        json_escape(&device)
    ))
}

fn transcribe_json(
    input: Option<PathBuf>,
    model: Option<PathBuf>,
    language: &Option<String>,
) -> Result<String, String> {
    let input = input.ok_or_else(|| "--input wav path required".to_string())?;
    let model = model.ok_or_else(|| "--model Parakeet model directory required".to_string())?;
    let result = transcribe_wav(&input, &model, language)?;
    Ok(format!(
        "{{\"ok\":true,\"event\":\"transcribed\",\"engine\":\"parakeet\",\"language\":{},\"text\":\"{}\",\"segments\":{},\"samples\":{}}}",
        result
            .language
            .as_ref()
            .map(|lang| format!("\"{}\"", json_escape(lang)))
            .unwrap_or_else(|| "null".to_string()),
        json_escape(result.text.trim()),
        result.segment_count,
        result.samples
    ))
}

fn transcribe_wav(
    input: &PathBuf,
    model: &PathBuf,
    language: &Option<String>,
) -> Result<TranscriptionSummary, String> {
    if !input.exists() {
        return Err(format!("input wav not found: {}", input.to_string_lossy()));
    }
    if !model.exists() {
        return Err(format!(
            "voice model not found: {}",
            model.to_string_lossy()
        ));
    }

    let (audio, sample_rate) = read_wav_mono_f32(input)?;
    transcribe_audio(audio, sample_rate, model, language)
}

fn transcribe_audio(
    audio: Vec<f32>,
    sample_rate: u32,
    model: &PathBuf,
    language: &Option<String>,
) -> Result<TranscriptionSummary, String> {
    let audio = if sample_rate == 16_000 {
        audio
    } else {
        resample_linear(&audio, sample_rate, 16_000)
    };

    let mut parakeet = ParakeetModel::load(&model, &Quantization::Int8)
        .map_err(|e| format!("cannot load Parakeet model: {e}"))?;
    let result = parakeet
        .transcribe(
            &audio,
            &TranscribeOptions {
                language: language.clone(),
                ..Default::default()
            },
        )
        .map_err(|e| format!("Parakeet transcription failed: {e}"))?;
    let segment_count = result
        .segments
        .as_ref()
        .map(|segments| segments.len())
        .unwrap_or(0);
    Ok(TranscriptionSummary {
        text: result.text.trim().to_string(),
        language: language.clone(),
        segment_count,
        samples: audio.len(),
    })
}

fn read_wav_mono_f32(path: &PathBuf) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("cannot open wav: {e}"))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let mut raw = Vec::<f32>::new();
    match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Int, 16) => {
            for sample in reader.samples::<i16>() {
                raw.push(
                    sample.map_err(|e| format!("invalid wav sample: {e}"))? as f32
                        / i16::MAX as f32,
                );
            }
        }
        (hound::SampleFormat::Int, 32) => {
            for sample in reader.samples::<i32>() {
                raw.push(
                    sample.map_err(|e| format!("invalid wav sample: {e}"))? as f32
                        / i32::MAX as f32,
                );
            }
        }
        (hound::SampleFormat::Float, 32) => {
            for sample in reader.samples::<f32>() {
                raw.push(sample.map_err(|e| format!("invalid wav sample: {e}"))?);
            }
        }
        _ => {
            return Err(format!(
                "unsupported wav format: {:?} {} bits",
                spec.sample_format, spec.bits_per_sample
            ))
        }
    }

    if channels == 1 {
        return Ok((raw, spec.sample_rate));
    }
    let mut mono = Vec::with_capacity(raw.len() / channels);
    for frame in raw.chunks(channels) {
        mono.push(frame.iter().sum::<f32>() / frame.len() as f32);
    }
    Ok((mono, spec.sample_rate))
}

fn resample_linear(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if input.is_empty() || source_rate == target_rate {
        return input.to_vec();
    }
    let ratio = source_rate as f64 / target_rate as f64;
    let target_len = ((input.len() as f64) / ratio).max(1.0).round() as usize;
    let mut output = Vec::with_capacity(target_len);
    for i in 0..target_len {
        let pos = i as f64 * ratio;
        let left = pos.floor() as usize;
        let right = (left + 1).min(input.len() - 1);
        let frac = (pos - left as f64) as f32;
        output.push(input[left] * (1.0 - frac) + input[right] * frac);
    }
    output
}

fn devices_json() -> Result<String, String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(devices_json_inner());
    });
    rx.recv_timeout(Duration::from_millis(1_500))
        .map_err(|_| "input device listing timed out".to_string())?
}

fn devices_json_inner() -> Result<String, String> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let mut out = String::from("{\"ok\":true,\"devices\":[");
    let devices = host
        .input_devices()
        .map_err(|e| format!("cannot list input devices: {e}"))?;
    for (idx, device) in devices.enumerate() {
        if idx > 0 {
            out.push(',');
        }
        let name = device.name().unwrap_or_else(|_| "Input device".to_string());
        let is_default = default_name.as_ref().map(|d| d == &name).unwrap_or(false);
        out.push_str(&format!(
            "{{\"id\":\"{}\",\"name\":\"{}\",\"default\":{}}}",
            idx,
            json_escape(&name),
            is_default
        ));
    }
    out.push_str("]}");
    Ok(out)
}

fn input_config_for_device(device: &Device) -> Result<SupportedStreamConfig, String> {
    match device.default_input_config() {
        Ok(config) => Ok(config),
        Err(default_err) => {
            let configs = device.supported_input_configs().map_err(|err| {
                format!(
                    "cannot read input configs after default config failed ({default_err}): {err}"
                )
            })?;
            let mut fallback: Option<SupportedStreamConfig> = None;
            for range in configs {
                let min = range.min_sample_rate().0;
                let max = range.max_sample_rate().0;
                let sample_rate = if min <= 16_000 && 16_000 <= max {
                    SampleRate(16_000)
                } else if min <= 48_000 && 48_000 <= max {
                    SampleRate(48_000)
                } else {
                    range.max_sample_rate()
                };
                let config = range.with_sample_rate(sample_rate);
                if matches!(
                    config.sample_format(),
                    SampleFormat::F32 | SampleFormat::I16
                ) {
                    return Ok(config);
                }
                if fallback.is_none() {
                    fallback = Some(config);
                }
            }
            fallback.ok_or_else(|| {
                format!("no supported input config after default config failed: {default_err}")
            })
        }
    }
}

fn capture_json(duration_ms: u64, wav_path: Option<PathBuf>) -> Result<String, String> {
    let summary = capture_default_input(duration_ms, wav_path)?;
    Ok(format!(
        "{{\"ok\":true,\"event\":\"audio-captured\",\"sampleRate\":{},\"durationMs\":{},\"samples\":{},\"rms\":{},\"peak\":{},\"speechDetected\":{},\"wavPath\":{}}}",
        summary.sample_rate,
        summary.duration_ms,
        summary.samples,
        format_float(summary.rms),
        format_float(summary.peak),
        summary.rms > 0.01 || summary.peak > 0.04,
        summary
            .wav_path
            .map(|p| format!("\"{}\"", json_escape(&p)))
            .unwrap_or_else(|| "null".to_string())
    ))
}

fn capture_default_input(
    duration_ms: u64,
    wav_path: Option<PathBuf>,
) -> Result<CaptureSummary, String> {
    let duration_ms = duration_ms.clamp(100, 30_000);
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default input device".to_string())?;
    let config = input_config_for_device(&device)?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let samples_for_stream = samples.clone();

    let stream = build_stream(&device, &config, channels, samples_for_stream)?;
    stream
        .play()
        .map_err(|e| format!("cannot start microphone stream: {e}"))?;
    thread::sleep(Duration::from_millis(duration_ms));
    drop(stream);

    let captured = samples
        .lock()
        .map_err(|_| "audio capture lock poisoned".to_string())?
        .clone();
    let (rms, peak) = audio_levels(&captured);
    let wav_output = if let Some(path) = wav_path {
        write_wav(&path, sample_rate, &captured)?;
        Some(path.to_string_lossy().to_string())
    } else {
        None
    };
    Ok(CaptureSummary {
        sample_rate,
        duration_ms,
        samples: captured.len(),
        rms,
        peak,
        wav_path: wav_output,
    })
}

impl RecorderDaemon {
    fn start(&mut self, wav_path: PathBuf) -> Result<String, String> {
        if self.active.is_some() {
            return Err("recording already active".to_string());
        }
        let active = start_default_recording(wav_path)?;
        let sample_rate = active.sample_rate;
        let path = active.wav_path.to_string_lossy().to_string();
        self.active = Some(active);
        Ok(format!(
            "{{\"ok\":true,\"event\":\"recording-started\",\"sampleRate\":{},\"wavPath\":\"{}\"}}",
            sample_rate,
            json_escape(&path)
        ))
    }

    fn stop(&mut self, model: Option<PathBuf>, language: Option<String>) -> Result<String, String> {
        let active = self
            .active
            .take()
            .ok_or_else(|| "recording not active".to_string())?;
        let summary = stop_recording(active)?;
        let speech_detected = summary.rms > 0.01 || summary.peak > 0.04;
        let mut text = String::new();
        let mut transcribed = false;
        let mut segments = 0usize;
        if speech_detected {
            if let (Some(model_path), Some(wav_path)) = (model, summary.wav_path.as_ref()) {
                let result = transcribe_wav(&PathBuf::from(wav_path), &model_path, &language)?;
                text = result.text;
                transcribed = true;
                segments = result.segment_count;
            }
        }
        Ok(format!(
            "{{\"ok\":true,\"event\":\"recording-stopped\",\"sampleRate\":{},\"durationMs\":{},\"samples\":{},\"rms\":{},\"peak\":{},\"speechDetected\":{},\"wavPath\":{},\"transcribed\":{},\"text\":\"{}\",\"segments\":{}}}",
            summary.sample_rate,
            summary.duration_ms,
            summary.samples,
            format_float(summary.rms),
            format_float(summary.peak),
            speech_detected,
            summary
                .wav_path
                .map(|p| format!("\"{}\"", json_escape(&p)))
                .unwrap_or_else(|| "null".to_string()),
            transcribed,
            json_escape(&text),
            segments
        ))
    }

    fn cancel(&mut self) -> Result<String, String> {
        self.active.take();
        Ok(ok_json("recording-cancelled"))
    }
}

fn start_default_recording(wav_path: PathBuf) -> Result<ActiveRecording, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default input device".to_string())?;
    let config = input_config_for_device(&device)?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let stream = build_stream(&device, &config, channels, samples.clone())?;
    stream
        .play()
        .map_err(|e| format!("cannot start microphone stream: {e}"))?;
    let level_emitter = LevelEmitter::start(sample_rate, samples.clone());
    Ok(ActiveRecording {
        stream,
        samples,
        sample_rate,
        started_at: Instant::now(),
        wav_path,
        _level_emitter: level_emitter,
    })
}

fn stop_recording(active: ActiveRecording) -> Result<CaptureSummary, String> {
    let duration_ms = active
        .started_at
        .elapsed()
        .as_millis()
        .clamp(1, u128::from(u64::MAX)) as u64;
    drop(active.stream);
    let captured = active
        .samples
        .lock()
        .map_err(|_| "audio capture lock poisoned".to_string())?
        .clone();
    let (rms, peak) = audio_levels(&captured);
    write_wav(&active.wav_path, active.sample_rate, &captured)?;
    Ok(CaptureSummary {
        sample_rate: active.sample_rate,
        duration_ms,
        samples: captured.len(),
        rms,
        peak,
        wav_path: Some(active.wav_path.to_string_lossy().to_string()),
    })
}

fn default_recording_path() -> PathBuf {
    let mut dir = env::temp_dir();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    dir.push(format!("bridge-voice-{ts}.wav"));
    dir
}

fn build_stream(
    device: &Device,
    config: &SupportedStreamConfig,
    channels: usize,
    samples: Arc<Mutex<Vec<f32>>>,
) -> Result<cpal::Stream, String> {
    let stream_config = config.config();
    let err_fn = |err| eprintln!("bridge-voice stream error: {err}");
    match config.sample_format() {
        SampleFormat::F32 => device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _| push_samples(data, channels, &samples, |v| v),
                err_fn,
                None,
            )
            .map_err(|e| format!("cannot build f32 input stream: {e}")),
        SampleFormat::I16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    push_samples(data, channels, &samples, |v| v as f32 / i16::MAX as f32)
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("cannot build i16 input stream: {e}")),
        SampleFormat::U16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    push_samples(data, channels, &samples, |v| {
                        (v as f32 / u16::MAX as f32) * 2.0 - 1.0
                    })
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("cannot build u16 input stream: {e}")),
        SampleFormat::I32 => device
            .build_input_stream(
                &stream_config,
                move |data: &[i32], _| {
                    push_samples(data, channels, &samples, |v| v as f32 / i32::MAX as f32)
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("cannot build i32 input stream: {e}")),
        SampleFormat::U32 => device
            .build_input_stream(
                &stream_config,
                move |data: &[u32], _| {
                    push_samples(data, channels, &samples, |v| {
                        (v as f32 / u32::MAX as f32) * 2.0 - 1.0
                    })
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("cannot build u32 input stream: {e}")),
        SampleFormat::I8 => device
            .build_input_stream(
                &stream_config,
                move |data: &[i8], _| {
                    push_samples(data, channels, &samples, |v| v as f32 / i8::MAX as f32)
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("cannot build i8 input stream: {e}")),
        SampleFormat::U8 => device
            .build_input_stream(
                &stream_config,
                move |data: &[u8], _| {
                    push_samples(data, channels, &samples, |v| {
                        (v as f32 / u8::MAX as f32) * 2.0 - 1.0
                    })
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("cannot build u8 input stream: {e}")),
        other => Err(format!("unsupported sample format: {other:?}")),
    }
}

fn push_samples<T, F>(data: &[T], channels: usize, samples: &Arc<Mutex<Vec<f32>>>, convert: F)
where
    T: Copy,
    F: Fn(T) -> f32,
{
    if channels == 0 {
        return;
    }
    if let Ok(mut out) = samples.lock() {
        for frame in data.chunks(channels) {
            let sum = frame.iter().map(|sample| convert(*sample)).sum::<f32>();
            out.push((sum / frame.len() as f32).clamp(-1.0, 1.0));
        }
    }
}

fn audio_levels(samples: &[f32]) -> (f32, f32) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    let sum_sq = samples.iter().map(|s| s * s).sum::<f32>();
    let peak = samples
        .iter()
        .fold(0.0_f32, |acc, sample| acc.max(sample.abs()));
    ((sum_sq / samples.len() as f32).sqrt(), peak)
}

fn write_wav(path: &PathBuf, sample_rate: u32, samples: &[f32]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create wav directory: {e}"))?;
    }
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer =
        hound::WavWriter::create(path, spec).map_err(|e| format!("cannot create wav: {e}"))?;
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer
            .write_sample(value)
            .map_err(|e| format!("cannot write wav sample: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("cannot finalize wav: {e}"))?;
    Ok(())
}

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
}

fn arg_u64(args: &[String], flag: &str) -> Option<u64> {
    arg_value(args, flag).and_then(|value| value.parse::<u64>().ok())
}

fn ok_json(event: &str) -> String {
    format!("{{\"ok\":true,\"event\":\"{}\"}}", json_escape(event))
}

fn paste_json() -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("cannot initialize keyboard automation: {e}"))?;
    send_paste_ctrl_v(&mut enigo)?;
    Ok(ok_json("paste-sent"))
}

fn validate_shortcut_json(shortcut: Option<String>) -> Result<String, String> {
    let shortcut =
        normalize_shortcut_aliases(&shortcut.ok_or_else(|| "--shortcut required".to_string())?);
    let _: Hotkey = shortcut
        .parse()
        .map_err(|e| format!("invalid shortcut '{}': {e}", shortcut))?;
    Ok(format!(
        "{{\"ok\":true,\"event\":\"shortcut-valid\",\"shortcut\":\"{}\"}}",
        json_escape(&shortcut)
    ))
}

fn watch_shortcut(shortcut: Option<String>) -> Result<String, String> {
    let shortcut =
        normalize_shortcut_aliases(&shortcut.ok_or_else(|| "--shortcut required".to_string())?);
    let hotkey: Hotkey = shortcut
        .parse()
        .map_err(|e| format!("invalid shortcut '{}': {e}", shortcut))?;
    let manager = HotkeyManager::new_with_blocking()
        .map_err(|e| format!("cannot initialize handy-keys: {e}"))?;
    let id = manager
        .register(hotkey)
        .map_err(|e| format!("cannot register shortcut '{}': {e}", shortcut))?;
    println!(
        "{{\"ok\":true,\"event\":\"shortcut-watching\",\"shortcut\":\"{}\"}}",
        json_escape(&shortcut)
    );
    let _ = io::stdout().flush();
    loop {
        while let Some(event) = manager.try_recv() {
            if event.id != id {
                continue;
            }
            let pressed = event.state == HotkeyState::Pressed;
            println!(
                "{{\"ok\":true,\"event\":\"shortcut\",\"shortcut\":\"{}\",\"pressed\":{}}}",
                json_escape(&shortcut),
                pressed
            );
            let _ = io::stdout().flush();
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn normalize_shortcut_aliases(shortcut: &str) -> String {
    shortcut
        .split('+')
        .map(|part| {
            let trimmed = part.trim();
            let lower = trimmed.to_ascii_lowercase();
            match lower.as_str() {
                "commandorcontrol" | "cmdorctrl" | "cmdorcontrol" | "controlorcommand" => {
                    if cfg!(target_os = "macos") {
                        "command".to_string()
                    } else {
                        "ctrl".to_string()
                    }
                }
                "control" => "ctrl".to_string(),
                "option" => {
                    if cfg!(target_os = "macos") {
                        "option".to_string()
                    } else {
                        "alt".to_string()
                    }
                }
                "return" => "enter".to_string(),
                "esc" => "escape".to_string(),
                _ => lower,
            }
        })
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("+")
}

fn send_paste_ctrl_v(enigo: &mut Enigo) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let (modifier_key, v_key_code) = (Key::Meta, Key::Other(9));
    #[cfg(target_os = "windows")]
    let (modifier_key, v_key_code) = (Key::Control, Key::Other(0x56));
    #[cfg(target_os = "linux")]
    let (modifier_key, v_key_code) = (Key::Control, Key::Unicode('v'));

    enigo
        .key(modifier_key, Direction::Press)
        .map_err(|e| format!("cannot press paste modifier: {e}"))?;
    enigo
        .key(v_key_code, Direction::Click)
        .map_err(|e| format!("cannot press paste key: {e}"))?;
    thread::sleep(Duration::from_millis(80));
    enigo
        .key(modifier_key, Direction::Release)
        .map_err(|e| format!("cannot release paste modifier: {e}"))?;
    Ok(())
}

fn error_json(error: String) -> String {
    format!("{{\"ok\":false,\"error\":\"{}\"}}", json_escape(&error))
}

fn help_text() -> String {
    "{\"ok\":true,\"usage\":\"bridge-voice status|devices|test-microphone|record --duration-ms <ms> --output <wav>|transcribe --input <wav> --model <parakeet-model-dir>|paste|validate-shortcut --shortcut <hotkey>|watch-shortcut --shortcut <hotkey>|start|stop|cancel|set-shortcut <accelerator>\"}".to_string()
}

fn format_float(value: f32) -> String {
    format!("{value:.6}")
}

fn json_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}
