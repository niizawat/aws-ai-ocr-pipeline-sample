'use client';

import * as React from 'react';
import { useColorScheme } from '@mui/material/styles';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import LightModeIcon from '@mui/icons-material/LightModeRounded';
import DarkModeIcon from '@mui/icons-material/DarkModeRounded';

export default function ColorModeButton() {
  const { mode, setMode } = useColorScheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <IconButton size="small" disabled sx={{ width: 36, height: 36 }} />;
  }

  const resolved = mode === 'system' ? 'light' : mode;
  const next = resolved === 'dark' ? 'light' : 'dark';

  return (
    <Tooltip title={next === 'dark' ? 'ダークモード' : 'ライトモード'}>
      <IconButton
        size="small"
        onClick={() => setMode(next)}
        aria-label="カラーモード切替"
      >
        {resolved === 'dark' ? (
          <LightModeIcon fontSize="small" />
        ) : (
          <DarkModeIcon fontSize="small" />
        )}
      </IconButton>
    </Tooltip>
  );
}
