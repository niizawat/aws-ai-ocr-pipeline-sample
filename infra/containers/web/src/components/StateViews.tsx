'use client';

import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import InboxIcon from '@mui/icons-material/Inbox';

export function LoadingView({ label = '読み込み中...' }: { label?: string }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        py: 8,
        color: 'text.secondary',
      }}
    >
      <CircularProgress />
      <Typography variant="body2">{label}</Typography>
    </Box>
  );
}

export function ErrorView({ message }: { message: string }) {
  return (
    <Alert severity="error" variant="outlined" sx={{ my: 2 }}>
      {message}
    </Alert>
  );
}

export function EmptyView({ message }: { message: string }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1.5,
        py: 8,
        color: 'text.secondary',
      }}
    >
      <InboxIcon sx={{ fontSize: 48, opacity: 0.5 }} />
      <Typography variant="body2">{message}</Typography>
    </Box>
  );
}
