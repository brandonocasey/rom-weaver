export function createWasmEnvImports(memory) {
  const imports = {
    __cxa_allocate_exception() {
      return 0;
    },
    __cxa_throw(pointer, typeInfo) {
      throw new Error(
        `rom-weaver wasm raised a C++ exception (pointer=${pointer}, type=${typeInfo})`,
      );
    },
  };

  if (memory instanceof WebAssembly.Memory) {
    imports.memory = memory;
  }

  return imports;
}

export function parseJsonLines(text, options = {}) {
  const events = [];
  const nonJsonLines = [];
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const onNonJsonLine = typeof options.onNonJsonLine === 'function'
    ? options.onNonJsonLine
    : null;

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      events.push(event);
      onEvent?.(event);
    } catch {
      nonJsonLines.push(line);
      onNonJsonLine?.(line);
    }
  }

  return { events, nonJsonLines };
}

export function parseTraceJsonLines(text, options = {}) {
  const traceEvents = [];
  const traceNonJsonLines = [];
  const onTraceEvent = typeof options.onTraceEvent === 'function' ? options.onTraceEvent : null;
  const onTraceNonJsonLine = typeof options.onTraceNonJsonLine === 'function'
    ? options.onTraceNonJsonLine
    : null;

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      traceEvents.push(event);
      onTraceEvent?.(event);
    } catch {
      traceNonJsonLines.push(line);
      onTraceNonJsonLine?.(line);
    }
  }

  return { traceEvents, traceNonJsonLines };
}
