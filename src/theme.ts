/** Semantic terminal palette. Source: https://catppuccin.com/palette/ (Mocha). */
import { createContext, useContext } from 'react';
import type { RowKind } from './history.ts';

/** Themes provide semantic roles so components never depend on palette-specific color names. */
export interface Theme {
  name: string;
  colors: Record<RowKind, string>;
  status: Record<'working' | 'ready' | 'offline' | 'model' | 'cost' | 'context' | 'warning' | 'critical' | 'usage', string>;
  accent: string;
  border: string;
}

/** Catppuccin Mocha, preserving the terminal background and its color-capability fallback. */
export const mocha: Theme = {
  name: 'Catppuccin Mocha',
  colors: { user: '#89b4fa', assistant: '#a6e3a1', context: '#f9e2af', text: '#cdd6f4',
    reasoning: '#cba6f7', tool: '#89dceb', success: '#a6e3a1', error: '#f38ba8', muted: '#a6adc8' },
  status: { working: '#f9e2af', ready: '#a6e3a1', offline: '#f38ba8', model: '#cba6f7',
    cost: '#89dceb', context: '#a6e3a1', warning: '#f9e2af', critical: '#f38ba8', usage: '#a6adc8' },
  accent: '#cba6f7', border: '#6c7086',
};

/** Components read semantic colors from the current application theme. */
export const ThemeContext = createContext(mocha);
/** Return the theme selected by the surrounding application provider. */
export function useTheme(): Theme { return useContext(ThemeContext); }
