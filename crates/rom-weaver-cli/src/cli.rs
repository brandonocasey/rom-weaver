#[cfg(target_arch = "wasm32")]
use std::path::PathBuf;
use std::{
    io::{self, IsTerminal},
    process::ExitCode,
    sync::{Arc, OnceLock},
};

#[cfg(not(target_arch = "wasm32"))]
use clap::Parser;
use rom_weaver_app::{AppRunOptions, Commands, RomWeaverApp};
#[cfg(target_arch = "wasm32")]
use rom_weaver_app::{
    BatchHeaderFixerCommand, ChecksumCommand, CompressCommand, CompressionLevelProfile,
    ExtractCommand, InspectCommand, PatchApplyCommand, PatchCreateCommand, TrimCommand,
};
use rom_weaver_core::ProgressSink;
#[cfg(target_arch = "wasm32")]
use rom_weaver_core::{RomWeaverError, ThreadBudget, XdeltaSecondaryMode};
use tracing::trace;
#[cfg(not(target_arch = "wasm32"))]
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Parser))]
#[cfg_attr(
    not(target_arch = "wasm32"),
    command(
        name = "rom-weaver",
        version,
        about = "Native CLI groundwork for ROM inspection, extraction, checksums, compression, trimming, and patching."
    )
)]
struct Cli {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            help = "Emit progress and terminal status as JSON lines"
        )
    )]
    json: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            conflicts_with = "no_progress",
            help = "Force running progress events on"
        )
    )]
    progress: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-progress",
            global = true,
            conflicts_with = "progress",
            help = "Disable running progress events"
        )
    )]
    no_progress: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            help = "Enable trace logs (also enabled by ROM_WEAVER_LOG or RUST_LOG)"
        )
    )]
    trace: bool,
    #[cfg_attr(not(target_arch = "wasm32"), command(subcommand))]
    command: Commands,
}

#[derive(Clone, Copy, Debug)]
pub struct RunCommandOptions {
    pub json: bool,
    pub trace: bool,
    pub emit_progress_events: bool,
    pub interactive_selection_enabled: bool,
}

impl RunCommandOptions {
    fn resolve_emit_progress_events(
        json: bool,
        progress: bool,
        no_progress: bool,
        stdout_is_tty: bool,
    ) -> bool {
        if no_progress {
            return false;
        }
        if progress {
            return true;
        }
        if json {
            return true;
        }
        stdout_is_tty
    }

    pub fn detect_for_terminal(json: bool, trace: bool, progress: bool, no_progress: bool) -> Self {
        let interactive_selection_enabled =
            !json && io::stdin().is_terminal() && io::stderr().is_terminal();
        let emit_progress_events = Self::resolve_emit_progress_events(
            json,
            progress,
            no_progress,
            io::stdout().is_terminal(),
        );
        Self {
            json,
            trace,
            emit_progress_events,
            interactive_selection_enabled,
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn main_entry() -> ExitCode {
    let cli = Cli::parse();
    let options =
        RunCommandOptions::detect_for_terminal(cli.json, cli.trace, cli.progress, cli.no_progress);
    run_command(cli.command, options)
}

#[cfg(target_arch = "wasm32")]
pub fn main_entry() -> ExitCode {
    let cli = match parse_wasm_cli() {
        Ok(cli) => cli,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::from(2);
        }
    };
    let options =
        RunCommandOptions::detect_for_terminal(cli.json, cli.trace, cli.progress, cli.no_progress);
    run_command(cli.command, options)
}

pub fn run_command(command: Commands, options: RunCommandOptions) -> ExitCode {
    init_trace_logging(options.trace, options.json);
    trace!(
        json = options.json,
        emit_progress_events = options.emit_progress_events,
        trace_requested = options.trace,
        command = ?command,
        "parsed command-line arguments"
    );
    let reporter: Arc<dyn ProgressSink> = if options.json {
        Arc::new(StdoutReporter::json())
    } else {
        Arc::new(StdoutReporter::text())
    };
    let outcome = RomWeaverApp::run(
        command,
        AppRunOptions {
            emit_progress_events: options.emit_progress_events,
            interactive_selection_enabled: options.interactive_selection_enabled,
        },
        reporter,
    );
    ExitCode::from(outcome.exit_code)
}

#[cfg(target_arch = "wasm32")]
type WasmCliParseResult<T> = std::result::Result<T, WasmCliParseError>;

include!("wasm_parse.rs");

include!("reporters.rs");

#[cfg(test)]
mod tests {
    use super::RunCommandOptions;

    #[test]
    fn progress_defaults_follow_tty_and_json_mode() {
        assert!(RunCommandOptions::resolve_emit_progress_events(
            false, false, false, true
        ));
        assert!(!RunCommandOptions::resolve_emit_progress_events(
            false, false, false, false
        ));
        assert!(RunCommandOptions::resolve_emit_progress_events(
            true, false, false, false
        ));
    }

    #[test]
    fn progress_flags_override_defaults() {
        assert!(RunCommandOptions::resolve_emit_progress_events(
            false, true, false, false
        ));
        assert!(!RunCommandOptions::resolve_emit_progress_events(
            true, false, true, true
        ));
    }
}
