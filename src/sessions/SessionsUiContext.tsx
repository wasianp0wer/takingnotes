import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import type { SessionsUiState, SessionsUiStore } from './sessionsUiStore';

const SessionsUiStoreContext = createContext<SessionsUiStore | null>(null);

export function SessionsUiProvider(props: { store: SessionsUiStore; children: ReactNode }) {
  return (
    <SessionsUiStoreContext.Provider value={props.store}>
      {props.children}
    </SessionsUiStoreContext.Provider>
  );
}

export function useSessionsUi(): [SessionsUiState, SessionsUiStore] {
  const store = useContext(SessionsUiStoreContext);
  if (store === null) throw new Error('useSessionsUi must be used within a SessionsUiProvider');
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return [state, store];
}
