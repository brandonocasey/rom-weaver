enum OutputMode {
    Json,
    Text {
        tty: bool,
        terminal_columns: Option<usize>,
        state: std::sync::Mutex<TextProgressState>,
    },
}

struct StdoutReporter {
    mode: OutputMode,
}

struct EmittedFileDetail {
    path: String,
    file_name: Option<String>,
    size_bytes: Option<u64>,
}

#[derive(Default)]
struct TextProgressState {
    inline_active: bool,
    last_running_line: Option<String>,
    active_command: Option<String>,
    highest_running_percent: Option<f32>,
    command_started_at: BTreeMap<String, std::time::Instant>,
}

impl StdoutReporter {
    fn json() -> Self {
        Self {
            mode: OutputMode::Json,
        }
    }

    fn text() -> Self {
        Self {
            mode: OutputMode::Text {
                tty: std::io::stdout().is_terminal(),
                terminal_columns: Self::detect_terminal_columns(),
                state: std::sync::Mutex::new(TextProgressState::default()),
            },
        }
    }

    fn detect_terminal_columns() -> Option<usize> {
        std::env::var("COLUMNS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 8)
    }

    fn format_percent(percent: f32) -> String {
        let clamped = percent.clamp(0.0, 100.0);
        let rounded = clamped.round();
        if (clamped - rounded).abs() <= 0.05 {
            return format!("{rounded:.0}%");
        }
        format!("{clamped:.1}%")
    }

    fn status_label(status: OperationStatus) -> &'static str {
        match status {
            OperationStatus::Pending => "pending",
            OperationStatus::Running => "running",
            OperationStatus::Succeeded => "succeeded",
            OperationStatus::Unsupported => "unsupported",
            OperationStatus::Failed => "failed",
            OperationStatus::Cancelled => "cancelled",
        }
    }

    fn event_label(event: &ProgressEvent) -> &str {
        if event.label.trim().is_empty() {
            event.stage.as_str()
        } else {
            event.label.as_str()
        }
    }

    fn shorten_label_paths(label: &str) -> String {
        let mut result = String::with_capacity(label.len());
        let mut remaining = label;
        loop {
            let Some(start) = remaining.find('`') else {
                result.push_str(remaining);
                break;
            };
            let (prefix, after_prefix) = remaining.split_at(start);
            result.push_str(prefix);
            let after_tick = &after_prefix[1..];
            let Some(end) = after_tick.find('`') else {
                result.push_str(after_prefix);
                break;
            };
            let (segment, tail) = after_tick.split_at(end);
            let shortened = if segment.contains('/') || segment.contains('\\') {
                std::path::Path::new(segment)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(segment)
            } else {
                segment
            };
            result.push('`');
            result.push_str(shortened);
            result.push('`');
            remaining = &tail[1..];
        }
        result
    }

    fn fit_to_terminal_width(line: String, terminal_columns: Option<usize>) -> String {
        let Some(width) = terminal_columns else {
            return line;
        };
        let line_width = line.chars().count();
        if line_width <= width {
            return line;
        }
        if width <= 3 {
            return line.chars().take(width).collect();
        }
        let mut truncated = line.chars().take(width - 3).collect::<String>();
        truncated.push_str("...");
        truncated
    }

    fn emitted_file_paths(event: &ProgressEvent) -> Vec<String> {
        let Some(serde_json::Value::Object(details)) = event.details.as_ref() else {
            return Vec::new();
        };
        let Some(serde_json::Value::Array(entries)) = details.get("emitted_files") else {
            return Vec::new();
        };
        entries
            .iter()
            .filter_map(|entry| match entry {
                serde_json::Value::Object(map) => map
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .map(|path| path.to_string()),
                _ => None,
            })
            .collect()
    }

    fn emitted_file_details(event: &ProgressEvent) -> Vec<EmittedFileDetail> {
        let Some(serde_json::Value::Object(details)) = event.details.as_ref() else {
            return Vec::new();
        };
        let Some(serde_json::Value::Array(entries)) = details.get("emitted_files") else {
            return Vec::new();
        };
        entries
            .iter()
            .filter_map(|entry| match entry {
                serde_json::Value::Object(map) => {
                    let path = map
                        .get("path")
                        .and_then(serde_json::Value::as_str)
                        .map(ToOwned::to_owned)?;
                    let file_name = map
                        .get("file_name")
                        .and_then(serde_json::Value::as_str)
                        .map(ToOwned::to_owned);
                    let size_bytes = map.get("size_bytes").and_then(serde_json::Value::as_u64);
                    Some(EmittedFileDetail {
                        path,
                        file_name,
                        size_bytes,
                    })
                }
                _ => None,
            })
            .collect()
    }

    fn emitted_file_count(event: &ProgressEvent) -> Option<usize> {
        let Some(serde_json::Value::Object(details)) = event.details.as_ref() else {
            return None;
        };
        let Some(serde_json::Value::Array(entries)) = details.get("emitted_files") else {
            return None;
        };
        Some(entries.len())
    }

    fn format_elapsed(elapsed: std::time::Duration) -> String {
        if elapsed.as_secs() >= 1 {
            format!("{:.2}s", elapsed.as_secs_f64())
        } else if elapsed.as_millis() >= 1 {
            format!("{}ms", elapsed.as_millis())
        } else {
            format!("{}us", elapsed.as_micros())
        }
    }

    fn format_size(size_bytes: u64) -> String {
        const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
        let mut value = size_bytes as f64;
        let mut unit_index = 0usize;
        while value >= 1024.0 && unit_index + 1 < UNITS.len() {
            value /= 1024.0;
            unit_index += 1;
        }
        if unit_index == 0 {
            format!("{size_bytes} {}", UNITS[unit_index])
        } else {
            format!("{value:.1} {}", UNITS[unit_index])
        }
    }

    fn backtick_segments(label: &str) -> Vec<String> {
        let mut segments = Vec::new();
        let mut remaining = label;
        loop {
            let Some(start) = remaining.find('`') else {
                break;
            };
            let after_tick = &remaining[start + 1..];
            let Some(end) = after_tick.find('`') else {
                break;
            };
            let (segment, tail) = after_tick.split_at(end);
            segments.push(segment.to_string());
            remaining = &tail[1..];
        }
        segments
    }

    fn shorten_path_segment(segment: &str) -> String {
        if segment.contains('/') || segment.contains('\\') {
            std::path::Path::new(segment)
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(segment)
                .to_string()
        } else {
            segment.to_string()
        }
    }

    fn extract_source_size_bytes(label: &str) -> Option<u64> {
        let source = Self::backtick_segments(label).into_iter().next()?;
        let source_path = std::path::Path::new(&source);
        let metadata = std::fs::metadata(source_path).ok()?;
        if metadata.is_file() {
            Some(metadata.len())
        } else {
            None
        }
    }

    fn extract_media_codecs(label: &str) -> Option<String> {
        let mut remaining = label;
        loop {
            let Some(start) = remaining.find('(') else {
                return None;
            };
            let after_start = &remaining[start + 1..];
            let Some(end) = after_start.find(')') else {
                return None;
            };
            let candidate = after_start[..end].trim();
            let lower = candidate.to_ascii_lowercase();
            if lower.contains("byte")
                || lower.contains("file")
                || lower.contains("written")
                || lower.contains("disc(")
                || lower.contains("disc(s)")
            {
                remaining = &after_start[end + 1..];
                continue;
            }
            if candidate.contains(',') {
                return Some(candidate.to_string());
            }
            remaining = &after_start[end + 1..];
        }
    }

    fn format_extract_terminal_lines(
        event: &ProgressEvent,
        elapsed: Option<std::time::Duration>,
    ) -> Option<Vec<String>> {
        if event.command != "extract" || event.status != OperationStatus::Succeeded {
            return None;
        }

        let source_label = Self::backtick_segments(&event.label)
            .into_iter()
            .next()
            .map(|segment| Self::shorten_path_segment(&segment))
            .unwrap_or_else(|| "source".to_string());
        let source_size = Self::extract_source_size_bytes(&event.label).map(Self::format_size);
        let media_codecs = Self::extract_media_codecs(&event.label);
        let elapsed = elapsed.map(Self::format_elapsed);
        let emitted_files = Self::emitted_file_details(event);

        let mut headline = format!("[extract] extracted `{source_label}`");
        if let Some(source_size) = source_size {
            headline.push(' ');
            headline.push_str(&source_size);
        }
        if let Some(media_codecs) = media_codecs {
            headline.push_str(&format!(" ({media_codecs})"));
        }
        if let Some(elapsed) = elapsed {
            headline.push_str(&format!(" in {elapsed}"));
        }
        if emitted_files.is_empty() {
            headline.push('.');
            return Some(vec![headline]);
        }
        headline.push_str(" to:");

        let mut lines = vec![headline];
        for emitted in emitted_files {
            let file_label = emitted
                .file_name
                .as_deref()
                .or_else(|| {
                    std::path::Path::new(&emitted.path)
                        .file_name()
                        .and_then(|value| value.to_str())
                })
                .unwrap_or(emitted.path.as_str());
            let size = emitted
                .size_bytes
                .map(Self::format_size)
                .unwrap_or_else(|| "unknown size".to_string());
            lines.push(format!("[extract]   `{file_label}` ({size})"));
        }
        Some(lines)
    }

    fn format_text_running_line(event: &ProgressEvent) -> String {
        let label = Self::shorten_label_paths(Self::event_label(event));
        let percent = event
            .percent
            .map(Self::format_percent)
            .map(|value| format!(" {value}"))
            .unwrap_or_default();
        format!("[{}] {}{}", event.command, label, percent)
    }

    fn format_text_terminal_line(event: &ProgressEvent) -> String {
        let label = Self::shorten_label_paths(Self::event_label(event));
        let percent_suffix = match event.percent {
            Some(value)
                if !matches!(event.status, OperationStatus::Succeeded)
                    || (value - 100.0).abs() > 0.05 =>
            {
                format!(" ({})", Self::format_percent(value))
            }
            _ => String::new(),
        };
        format!(
            "[{}] {}: {}{}",
            event.command,
            Self::status_label(event.status),
            label,
            percent_suffix
        )
    }
}

struct ProgressFilterReporter {
    inner: Arc<dyn ProgressSink>,
    allow_running: bool,
}

impl ProgressFilterReporter {
    fn suppress_running(inner: Arc<dyn ProgressSink>) -> Self {
        Self {
            inner,
            allow_running: false,
        }
    }
}

impl ProgressSink for ProgressFilterReporter {
    fn emit(&self, event: ProgressEvent) {
        if !self.allow_running && event.status == OperationStatus::Running {
            return;
        }
        self.inner.emit(event);
    }
}

impl ProgressSink for StdoutReporter {
    fn emit(&self, event: ProgressEvent) {
        match &self.mode {
            OutputMode::Json => match serde_json::to_string(&event) {
                Ok(serialized) => {
                    println!("{serialized}");
                    let _ = std::io::Write::flush(&mut std::io::stdout());
                }
                Err(error) => eprintln!("failed to serialize CLI progress event: {error}"),
            },
            OutputMode::Text {
                tty,
                terminal_columns,
                state,
            } => {
                let mut line = if event.status == OperationStatus::Running {
                    Self::format_text_running_line(&event)
                } else {
                    Self::format_text_terminal_line(&event)
                };
                if *tty {
                    line = Self::fit_to_terminal_width(line, *terminal_columns);
                }
                let mut state_guard = state.lock().expect("progress state lock");
                if event.status == OperationStatus::Running {
                    state_guard
                        .command_started_at
                        .entry(event.command.clone())
                        .or_insert_with(std::time::Instant::now);
                }

                if *tty && event.status == OperationStatus::Running {
                    if state_guard.active_command.as_deref() != Some(event.command.as_str()) {
                        state_guard.active_command = Some(event.command.clone());
                        state_guard.highest_running_percent = None;
                    }
                    if let Some(percent) = event.percent {
                        let clamped = percent.clamp(0.0, 100.0);
                        if let Some(highest) = state_guard.highest_running_percent {
                            if clamped + 0.05 < highest {
                                return;
                            }
                        }
                        let next_highest = state_guard
                            .highest_running_percent
                            .map_or(clamped, |highest| highest.max(clamped));
                        state_guard.highest_running_percent = Some(next_highest);
                    } else if state_guard
                        .highest_running_percent
                        .is_some_and(|highest| highest >= 99.95)
                    {
                        return;
                    }
                    if state_guard.last_running_line.as_deref() == Some(line.as_str()) {
                        return;
                    }
                    print!("\r\x1b[2K{line}");
                    let _ = std::io::Write::flush(&mut std::io::stdout());
                    state_guard.inline_active = true;
                    state_guard.last_running_line = Some(line);
                    return;
                }

                if state_guard.inline_active {
                    println!();
                    state_guard.inline_active = false;
                    state_guard.last_running_line = None;
                }
                let elapsed = if !matches!(event.status, OperationStatus::Running) {
                    state_guard
                        .command_started_at
                        .remove(&event.command)
                        .map(|started_at| started_at.elapsed())
                } else {
                    None
                };
                if let Some(extract_lines) = Self::format_extract_terminal_lines(&event, elapsed) {
                    for extract_line in extract_lines {
                        println!("{extract_line}");
                    }
                    state_guard.active_command = None;
                    state_guard.highest_running_percent = None;
                    let _ = std::io::Write::flush(&mut std::io::stdout());
                    return;
                }
                println!("{line}");
                if !matches!(event.status, OperationStatus::Running) {
                    if let Some(elapsed) = elapsed {
                        println!(
                            "[{}] elapsed: {}",
                            event.command,
                            Self::format_elapsed(elapsed)
                        );
                    }
                    if let Some(file_count) = Self::emitted_file_count(&event) {
                        println!("[{}] files: {}", event.command, file_count);
                    }
                    for emitted_path in Self::emitted_file_paths(&event) {
                        println!("[{}] output: {}", event.command, emitted_path);
                    }
                    state_guard.active_command = None;
                    state_guard.highest_running_percent = None;
                }
                let _ = std::io::Write::flush(&mut std::io::stdout());
            }
        }
    }
}
