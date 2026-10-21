import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import type { SearchState, SearchStore } from './searchStore';

const SearchStoreContext = createContext<SearchStore | null>(null);

export function SearchProvider(props: { store: SearchStore; children: ReactNode }) {
  return <SearchStoreContext.Provider value={props.store}>{props.children}</SearchStoreContext.Provider>;
}

export function useSearch(): [SearchState, SearchStore] {
  const store = useContext(SearchStoreContext);
  if (store === null) throw new Error('useSearch must be used within a SearchProvider');
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return [state, store];
}
