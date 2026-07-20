// Minimal framework-free store: shallow-merge updates and synchronously notify subscribers.
type StoreApi<TState> = {
  getState: () => TState;
  setState: (partial: Partial<TState> | ((state: TState) => Partial<TState>)) => void;
  subscribe: (listener: (state: TState, previousState: TState) => void) => () => void;
};

const createStore = <TState extends object>(initializer: () => TState): StoreApi<TState> => {
  let state = initializer();
  const listeners = new Set<(state: TState, previousState: TState) => void>();
  return {
    getState: () => state,
    setState: (partial) => {
      const partialState = typeof partial === "function" ? partial(state) : partial;
      const previousState = state;
      state = { ...state, ...partialState };
      for (const listener of listeners) listener(state, previousState);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export { createStore };
