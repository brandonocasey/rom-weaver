use std::{fmt, io, path::PathBuf};

use thiserror::Error;

pub type Result<T> = std::result::Result<T, RomWeaverError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationCodeError {
    code: &'static str,
    message: Option<&'static str>,
    fields: Vec<ValidationField>,
}

impl ValidationCodeError {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            message: None,
            fields: Vec::new(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn fields(&self) -> &[ValidationField] {
        &self.fields
    }

    pub fn with_message(mut self, message: &'static str) -> Self {
        self.message = Some(message);
        self
    }

    pub fn with_field(mut self, key: &'static str, value: impl Into<ValidationFieldValue>) -> Self {
        self.push_field(key, value);
        self
    }

    pub fn push_field(&mut self, key: &'static str, value: impl Into<ValidationFieldValue>) {
        self.fields.push(ValidationField {
            key,
            value: value.into(),
        });
    }
}

impl fmt::Display for ValidationCodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(message) = self.message {
            write!(f, "{} [{}]", message, self.code)?;
        } else {
            write!(f, "{}", self.code)?;
        }
        if self.fields.is_empty() {
            return Ok(());
        }

        write!(f, " (")?;
        for (index, field) in self.fields.iter().enumerate() {
            if index > 0 {
                write!(f, ", ")?;
            }
            write!(f, "{}={}", field.key, field.value)?;
        }
        write!(f, ")")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationField {
    pub key: &'static str,
    pub value: ValidationFieldValue,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationFieldValue {
    Bool(bool),
    I64(i64),
    U64(u64),
    Usize(usize),
    Text(String),
}

impl fmt::Display for ValidationFieldValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bool(value) => write!(f, "{value}"),
            Self::I64(value) => write!(f, "{value}"),
            Self::U64(value) => write!(f, "{value}"),
            Self::Usize(value) => write!(f, "{value}"),
            Self::Text(value) => write!(f, "{value}"),
        }
    }
}

impl From<bool> for ValidationFieldValue {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

macro_rules! impl_from_signed {
    ($($type:ty),* $(,)?) => {
        $(
            impl From<$type> for ValidationFieldValue {
                fn from(value: $type) -> Self {
                    Self::I64(value as i64)
                }
            }
        )*
    };
}

macro_rules! impl_from_unsigned {
    ($($type:ty),* $(,)?) => {
        $(
            impl From<$type> for ValidationFieldValue {
                fn from(value: $type) -> Self {
                    Self::U64(value as u64)
                }
            }
        )*
    };
}

impl_from_signed!(i8, i16, i32, i64);
impl_from_unsigned!(u8, u16, u32, u64);

impl From<usize> for ValidationFieldValue {
    fn from(value: usize) -> Self {
        Self::Usize(value)
    }
}

impl From<String> for ValidationFieldValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<&str> for ValidationFieldValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

#[derive(Debug, Error)]
pub enum RomWeaverError {
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("validation failed: {0}")]
    ValidationCode(ValidationCodeError),
    #[error("unknown format for path `{path}`")]
    UnknownFormat { path: PathBuf },
    #[error("unsupported operation: {0}")]
    Unsupported(UnsupportedOp),
    #[error("operation cancelled")]
    Cancelled,
    #[error("i/o error: {0}")]
    Io(#[from] io::Error),
    #[error("thread pool build failed: {0}")]
    ThreadPoolBuild(String),
}

/// A specific reason an operation could not be carried out. Each variant is a
/// distinct, matchable case carrying typed fields rather than a free-form
/// string; the `Display` impl renders the user-facing message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnsupportedOp {
    /// A container handler does not implement a registry-level operation.
    FormatOperation {
        format: String,
        operation: FormatOperationKind,
    },
    /// A handler required for a feature is not registered.
    HandlerNotRegistered {
        handler: &'static str,
        feature: &'static str,
    },
    /// A format supports extraction but not creation.
    ExtractOnlyCreate {
        format: String,
        supported_create_formats: String,
    },
    /// A libarchive backend does not support the requested codec.
    LibarchiveCodec { format: String, codec: String },
    /// The rust CHD compressed-create encoder does not support a codec for the
    /// given media scope.
    ChdCodecForMedia { codec: String, scope: ChdMediaScope },
    /// A CHD codec is not valid for a named media kind.
    ChdCodecInvalidForMedia { codec: String, media: String },
    /// The CHD codec list as a whole is invalid for a named media kind.
    ChdCodecListInvalid { media: String },
    /// Patch creation is not implemented for a format.
    PatchCreateNotImplemented {
        format: &'static str,
        alternative: &'static str,
    },
    /// RUP patches with named file entries cannot be applied by single-file apply.
    RupNamedFileEntries,
    /// HDiffPatch directory (HDIFF19) patches cannot be applied by patch-apply.
    HdiffDirectoryPatch,
    /// The rust CHD encoder only supports `avhuff` for `chav` frame inputs.
    ChdAvhuffRequiresChavFrames,
    /// The rust CHD create path only supports `store` mode for this input.
    ChdStoreModeOnly,
    /// CHD create against a parent needs at least one compressed codec.
    ChdParentRequiresCompression,
    /// avhuff encode exceeds the per-channel audio sample limit.
    ChdAvhuffSampleLimit { max_samples_per_channel: u32 },
}

/// Registry-level container operation that a handler may not implement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatOperationKind {
    ListEntries,
    CreateDryRunSize,
}

impl FormatOperationKind {
    fn phrase(self) -> &'static str {
        match self {
            Self::ListEntries => "listing entries",
            Self::CreateDryRunSize => "create dry-run size measurement",
        }
    }
}

/// Media scope a CHD codec was rejected for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChdMediaScope {
    /// The current compressed-create media mode (no specific media label).
    CompressedMediaMode,
    /// Disc media.
    Disc,
}

impl ChdMediaScope {
    fn phrase(self) -> &'static str {
        match self {
            Self::CompressedMediaMode => "this media mode",
            Self::Disc => "disc media",
        }
    }
}

impl fmt::Display for UnsupportedOp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FormatOperation { format, operation } => {
                write!(f, "{format} does not support {}", operation.phrase())
            }
            Self::HandlerNotRegistered { handler, feature } => {
                write!(
                    f,
                    "{handler} handler is not registered; {feature} is unavailable"
                )
            }
            Self::ExtractOnlyCreate {
                format,
                supported_create_formats,
            } => write!(
                f,
                "{format} is extract-only; supported create formats are {supported_create_formats}"
            ),
            Self::LibarchiveCodec { format, codec } => {
                write!(f, "libarchive does not support {format} codec `{codec}`")
            }
            Self::ChdCodecForMedia { codec, scope } => write!(
                f,
                "rust chd compressed create does not support codec `{codec}` for {}",
                scope.phrase()
            ),
            Self::ChdCodecInvalidForMedia { codec, media } => {
                write!(f, "chd codec `{codec}` is not valid for {media} media")
            }
            Self::ChdCodecListInvalid { media } => {
                write!(f, "chd codec list is invalid for {media} media")
            }
            Self::PatchCreateNotImplemented {
                format,
                alternative,
            } => write!(
                f,
                "{format} patch creation is not implemented; use {alternative}"
            ),
            Self::RupNamedFileEntries => write!(
                f,
                "RUP patches with named file entries are not supported by single-file patch-apply"
            ),
            Self::HdiffDirectoryPatch => write!(
                f,
                "HDiffPatch directory patches (HDIFF19) are not supported for patch-apply; expected single-file patch (.hdiff/.hpatchz)"
            ),
            Self::ChdAvhuffRequiresChavFrames => write!(
                f,
                "rust chd compressed create supports `avhuff` only for `chav` frame inputs"
            ),
            Self::ChdStoreModeOnly => write!(
                f,
                "rust chd create currently supports only raw/dvd/hd/disc `store` mode"
            ),
            Self::ChdParentRequiresCompression => write!(
                f,
                "chd create with parent requires at least one compressed codec; `store` mode cannot reference parent hunks"
            ),
            Self::ChdAvhuffSampleLimit {
                max_samples_per_channel,
            } => write!(
                f,
                "avhuff encode currently supports up to {max_samples_per_channel} audio samples per channel"
            ),
        }
    }
}
