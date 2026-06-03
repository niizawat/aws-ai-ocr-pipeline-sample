'use client';

import { createTheme } from '@mui/material/styles';

/**
 * 製造業の品質管理向けに、落ち着いたスレート基調 + ティール 1 アクセントの
 * プロフェッショナルなテーマ。CSS 変数とライト/ダーク両対応で実装する。
 */
const theme = createTheme({
  cssVariables: {
    colorSchemeSelector: 'class',
  },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#0f766e', light: '#14b8a6', dark: '#0b5650', contrastText: '#ffffff' },
        secondary: { main: '#b45309' },
        background: { default: '#f6f8fa', paper: '#ffffff' },
        success: { main: '#15803d' },
        warning: { main: '#b45309' },
        error: { main: '#b91c1c' },
        info: { main: '#0369a1' },
        divider: 'rgba(15, 23, 42, 0.08)',
        text: { primary: '#0f172a', secondary: '#475569' },
      },
    },
    dark: {
      palette: {
        primary: { main: '#2dd4bf', light: '#5eead4', dark: '#14b8a6', contrastText: '#062925' },
        secondary: { main: '#fbbf24' },
        background: { default: '#0b1120', paper: '#111a2e' },
        success: { main: '#4ade80' },
        warning: { main: '#fbbf24' },
        error: { main: '#f87171' },
        info: { main: '#38bdf8' },
        divider: 'rgba(148, 163, 184, 0.16)',
        text: { primary: '#e2e8f0', secondary: '#94a3b8' },
      },
    },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: 'var(--font-app), var(--font-jp), system-ui, sans-serif',
    h4: { fontWeight: 700, letterSpacing: '-0.02em' },
    h5: { fontWeight: 700, letterSpacing: '-0.01em' },
    h6: { fontWeight: 700 },
    subtitle1: { fontWeight: 600 },
    subtitle2: { fontWeight: 600 },
    button: { fontWeight: 600, textTransform: 'none' },
  },
  components: {
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: ({ theme: t }) => ({
          border: `1px solid ${t.palette.divider}`,
          backgroundImage: 'none',
        }),
      },
    },
    MuiPaper: {
      styleOverrides: { root: { backgroundImage: 'none' } },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { borderRadius: 10 } },
    },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: 'default' },
      styleOverrides: {
        root: ({ theme: t }) => ({
          backgroundColor: t.vars
            ? `rgba(${t.vars.palette.background.paperChannel} / 0.85)`
            : t.palette.background.paper,
          backdropFilter: 'saturate(180%) blur(8px)',
          borderBottom: `1px solid ${t.palette.divider}`,
        }),
      },
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 600 } },
    },
  },
});

export default theme;
