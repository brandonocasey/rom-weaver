const writeBlobToFileHandle = async (fileHandle: FileSystemFileHandle, blob: Blob) => {
  const writable = await fileHandle.createWritable();
  let writeError: unknown = null;
  try {
    await writable.write(blob);
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    if (writeError && typeof writable.abort === "function") {
      await writable.abort(writeError).catch(() => undefined);
    } else {
      await writable.close();
    }
  }
};

export { writeBlobToFileHandle };
