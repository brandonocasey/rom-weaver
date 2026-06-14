//! Shared `OperationReport.details` JSON builders.
//!
//! Container extract/compression reporting in `rom-weaver-containers` and
//! `rom-weaver-chd` emit the same `extraction`/thread-execution detail shapes;
//! these helpers are the single source so the JSON stays consistent across
//! crates.

use serde_json::{Map, Value, json};

use crate::{OperationReport, ThreadExecution};

/// Take the report's existing `details` object (or an empty map) so callers can
/// extend it without clobbering prior keys.
pub fn operation_report_details(report: &mut OperationReport) -> Map<String, Value> {
    match report.details.take() {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Insert the flattened thread-execution fields shared by the `extraction` and
/// `compression` detail blocks.
pub fn insert_thread_execution_details(
    details: &mut Map<String, Value>,
    execution: &ThreadExecution,
) {
    details.insert(
        "requested_threads".to_string(),
        json!(execution.requested_threads),
    );
    details.insert(
        "effective_threads".to_string(),
        json!(execution.effective_threads),
    );
    details.insert("thread_mode".to_string(), json!(execution.thread_mode));
    details.insert(
        "used_parallelism".to_string(),
        json!(execution.used_parallelism),
    );
    details.insert(
        "thread_fallback".to_string(),
        json!(execution.thread_fallback),
    );
    if let Some(reason) = &execution.thread_fallback_reason {
        details.insert("thread_fallback_reason".to_string(), json!(reason));
    }
}

/// Attach an `extraction` detail block (entry/file/byte counts + thread
/// execution) to an extract report.
pub fn attach_extraction_details(
    mut report: OperationReport,
    entry_count: usize,
    file_count: usize,
    written_bytes: u64,
    execution: &ThreadExecution,
) -> OperationReport {
    let mut details = operation_report_details(&mut report);
    let mut extraction = Map::new();
    extraction.insert("entries".to_string(), json!(entry_count));
    extraction.insert("files".to_string(), json!(file_count));
    extraction.insert("written_bytes".to_string(), json!(written_bytes));
    insert_thread_execution_details(&mut extraction, execution);
    details.insert("extraction".to_string(), Value::Object(extraction));
    report.details = Some(Value::Object(details));
    report
}
