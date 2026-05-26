import type { VfsFileRef } from "../storage/vfs/types.ts";

type DirectSource = string | Blob | FileSystemFileHandle | VfsFileRef;

type SourceObject = {
  fileName?: string;
  mediaType?: string;
  name?: string;
  size?: number;
  type?: string;
  source: DirectSource;
  data?: DirectSource;
};

type SourceRef = DirectSource | SourceObject;

type BrowserSourceObject = SourceObject;
type BrowserSourceRef = SourceRef;

export type { BrowserSourceObject, BrowserSourceRef, DirectSource, SourceObject, SourceRef };
