import { RomWeaverError } from "../../lib/errors.ts";

type PublicSourceValidationOptions = {
  environmentLabel: string;
};

const isUnsupportedByteSource = (source: unknown) => source instanceof ArrayBuffer || ArrayBuffer.isView(source);
const isUnsupportedPathSource = (source: unknown) => typeof source === "string";

const isBlob = (source: unknown) => typeof Blob !== "undefined" && source instanceof Blob;
const isFileSystemFileHandleLike = (source: unknown) =>
  !!(
    source &&
    typeof source === "object" &&
    (source as { kind?: unknown }).kind === "file" &&
    typeof (source as { getFile?: unknown }).getFile === "function"
  );
const isSourceWrapper = (source: unknown): source is { data?: unknown; source?: unknown } =>
  !!source && typeof source === "object" && ("data" in source || "source" in source);
const isVfsFileRef = (source: unknown) =>
  !!source && typeof source === "object" && "vfs" in source && typeof (source as { path?: unknown }).path === "string";

const getReceivedType = (source: unknown) => source?.constructor?.name || typeof source;
const getWrappedSource = (source: { data?: unknown; source?: unknown }) => source.source ?? source.data;

const throwUnsupportedSource = (message: string, source: unknown): never => {
  throw new RomWeaverError("SOURCE_UNSUPPORTED", message, { details: { received: getReceivedType(source) } });
};

const assertRawByteSource = (source: unknown, environmentLabel: string) => {
  if (isUnsupportedByteSource(source))
    throwUnsupportedSource(`Raw byte sources are not public ${environmentLabel} inputs`, source);
  if (isSourceWrapper(source) && isUnsupportedByteSource(getWrappedSource(source)))
    throwUnsupportedSource(
      `Raw byte source wrappers are not public ${environmentLabel} inputs`,
      getWrappedSource(source),
    );
};

const assertPathSource = (source: unknown, environmentLabel: string) => {
  if (isUnsupportedPathSource(source))
    throwUnsupportedSource(`Path strings are not public ${environmentLabel} inputs`, source);
  if (isSourceWrapper(source) && isUnsupportedPathSource(getWrappedSource(source)))
    throwUnsupportedSource(`Path source wrappers are not public ${environmentLabel} inputs`, getWrappedSource(source));
};

const assertVfsSource = (source: unknown, environmentLabel: string) => {
  if (isVfsFileRef(source)) throwUnsupportedSource(`VFS path refs are not public ${environmentLabel} inputs`, source);
  if (isSourceWrapper(source) && isVfsFileRef(getWrappedSource(source)))
    throwUnsupportedSource(`VFS path ref wrappers are not public ${environmentLabel} inputs`, getWrappedSource(source));
};

const assertSupportedSourceKind = (source: unknown, environmentLabel: string) => {
  assertRawByteSource(source, environmentLabel);
  assertPathSource(source, environmentLabel);
  assertVfsSource(source, environmentLabel);
};

const assertSupportedSourceShape = (source: unknown, environmentLabel: string) => {
  if (
    source &&
    typeof source === "object" &&
    !isBlob(source) &&
    !isFileSystemFileHandleLike(source) &&
    !isSourceWrapper(source)
  ) {
    throw new RomWeaverError(
      "INVALID_INPUT",
      `${environmentLabel} public sources must be Blob values, file handles, or source wrappers`,
      { details: { received: source.constructor.name } },
    );
  }
};

const createPublicSourceValidator =
  ({ environmentLabel }: PublicSourceValidationOptions) =>
  (source: unknown) => {
    assertSupportedSourceKind(source, environmentLabel);
    assertSupportedSourceShape(source, environmentLabel);
  };

const createPublicSourcesValidator =
  <TSource>(assertPublicSource: (source: unknown) => void) =>
  (sources: TSource | TSource[] | undefined) => {
    const sourceList = Array.isArray(sources) ? sources : [];
    if (sources && !Array.isArray(sources)) sourceList.push(sources);
    for (const source of sourceList) assertPublicSource(source);
  };

export { createPublicSourcesValidator, createPublicSourceValidator };
