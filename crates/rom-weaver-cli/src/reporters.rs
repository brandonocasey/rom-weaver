enum OutputMode {
    Json,
    Text,
}

struct StdoutReporter {
    mode: OutputMode,
}

impl StdoutReporter {
    fn json() -> Self {
        Self {
            mode: OutputMode::Json,
        }
    }

    fn text() -> Self {
        Self {
            mode: OutputMode::Text,
        }
    }
}

impl ProgressSink for StdoutReporter {
    fn emit(&self, event: rom_weaver_core::ProgressEvent) {
        match self.mode {
            OutputMode::Json => match serde_json::to_string(&event) {
                Ok(serialized) => {
                    println!("{serialized}");
                    let _ = std::io::Write::flush(&mut std::io::stdout());
                }
                Err(error) => eprintln!("failed to serialize CLI progress event: {error}"),
            },
            OutputMode::Text => {
                let format = event.format.as_deref().unwrap_or("-");
                let threads = match (
                    event.requested_threads,
                    event.effective_threads,
                    event.used_parallelism,
                    event.thread_mode,
                ) {
                    (
                        Some(requested),
                        Some(effective),
                        Some(used_parallelism),
                        Some(thread_mode),
                    ) => {
                        format!(
                            " requested_threads={requested} effective_threads={effective} thread_mode={thread_mode:?} used_parallelism={used_parallelism}"
                        )
                    }
                    _ => String::new(),
                };
                println!(
                    "[{}] family={:?} format={} stage={} status={:?} label={}{}",
                    event.command,
                    event.family,
                    format,
                    event.stage,
                    event.status,
                    event.label,
                    threads,
                );
                let _ = std::io::Write::flush(&mut std::io::stdout());
            }
        }
    }
}
