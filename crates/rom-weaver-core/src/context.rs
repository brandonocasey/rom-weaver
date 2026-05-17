use std::{path::Path, path::PathBuf, sync::Arc};

use crate::{
    CancellationToken, ProgressEvent, ProgressSink, Result, SharedThreadPool, TempPathAllocator,
    ThreadBudget, ThreadCapability, ThreadExecution,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatchChecksumValidation {
    Strict,
    Ignore,
}

#[derive(Clone)]
pub struct OperationContext {
    thread_budget: ThreadBudget,
    temp_paths: Arc<TempPathAllocator>,
    progress: Arc<dyn ProgressSink>,
    cancel: CancellationToken,
    patch_checksum_validation: PatchChecksumValidation,
}

impl OperationContext {
    pub fn new(
        thread_budget: ThreadBudget,
        temp_root: PathBuf,
        progress: Arc<dyn ProgressSink>,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            thread_budget,
            temp_paths: Arc::new(TempPathAllocator::new(temp_root)),
            progress,
            cancel,
            patch_checksum_validation: PatchChecksumValidation::Strict,
        }
    }

    pub fn thread_budget(&self) -> ThreadBudget {
        self.thread_budget
    }

    pub fn temp_root(&self) -> &Path {
        self.temp_paths.root()
    }

    pub fn temp_paths(&self) -> &TempPathAllocator {
        self.temp_paths.as_ref()
    }

    pub fn cancel(&self) -> &CancellationToken {
        &self.cancel
    }

    pub fn patch_checksum_validation(&self) -> PatchChecksumValidation {
        self.patch_checksum_validation
    }

    pub fn with_patch_checksum_validation(self, validation: PatchChecksumValidation) -> Self {
        Self {
            patch_checksum_validation: validation,
            ..self
        }
    }

    pub fn emit(&self, event: ProgressEvent) {
        self.progress.emit(event);
    }

    pub fn plan_threads(&self, capability: ThreadCapability) -> ThreadExecution {
        capability.negotiate(self.thread_budget)
    }

    pub fn build_pool(
        &self,
        capability: ThreadCapability,
    ) -> Result<(ThreadExecution, SharedThreadPool)> {
        let execution = self.plan_threads(capability);
        let pool = SharedThreadPool::with_execution(&execution)?;
        Ok((execution, pool))
    }
}
