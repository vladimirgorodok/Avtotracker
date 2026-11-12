/** Глобальное состояние приложения: настройки, справочники, уведомления. */

import { create } from 'zustand';
import { getSettings, setSetting } from './db/repo';
import { DEFAULT_SETTINGS, type AppSettings } from './types';

export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'err' | 'info';
}

interface AppState {
  ready: boolean;
  settings: AppSettings;
  /** Меняется при любом изменении данных, чтобы списки перечитались */
  revision: number;
  toasts: Toast[];
  init: () => void;
  patch: (p: Partial<AppSettings>) => void;
  saveSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  touch: () => void;
  notify: (text: string, kind?: Toast['kind']) => void;
  dismiss: (id: number) => void;
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  settings: DEFAULT_SETTINGS,
  revision: 0,
  toasts: [],

  init: () => set({ settings: getSettings(), ready: true }),

  patch: (p) => set({ settings: { ...get().settings, ...p } }),

  saveSetting: (key, value) => {
    setSetting(key, value as string | number);
    set({ settings: { ...get().settings, [key]: value } });
  },

  touch: () => set({ revision: get().revision + 1 }),

  notify: (text, kind = 'info') => {
    const id = Date.now() + Math.random();
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => get().dismiss(id), 3200);
  },

  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Применить тему к документу */
export function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
}
