'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Box from '@mui/material/Box';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Avatar from '@mui/material/Avatar';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import MenuIcon from '@mui/icons-material/MenuRounded';
import InsightsIcon from '@mui/icons-material/InsightsRounded';
import type { SxProps, Theme } from '@mui/material/styles';

import { NAV_ITEMS, APP_TITLE } from '@/components/nav';
import ColorModeButton from '@/components/ColorModeButton';

const DRAWER_WIDTH = 264;

const styles: Record<string, SxProps<Theme>> = {
  brand: {
    px: 2.5,
    py: 2.5,
    display: 'flex',
    alignItems: 'center',
    gap: 1.5,
  },
  brandMark: {
    width: 40,
    height: 40,
    borderRadius: 2,
    display: 'grid',
    placeItems: 'center',
    color: 'primary.contrastText',
    background: (t: Theme) =>
      `linear-gradient(135deg, ${t.palette.primary.main}, ${t.palette.primary.dark})`,
  },
  navList: { px: 1.5, py: 1, flex: 1 },
  navButton: {
    borderRadius: 2,
    mb: 0.5,
    py: 1,
    '&.Mui-selected': {
      bgcolor: 'primary.main',
      color: 'primary.contrastText',
      '& .MuiListItemIcon-root': { color: 'primary.contrastText' },
      '&:hover': { bgcolor: 'primary.dark' },
    },
  },
};

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const activeItem =
    NAV_ITEMS.find((item) => pathname.startsWith(item.href)) ?? NAV_ITEMS[0];

  const drawerContent = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={styles.brand}>
        <Box sx={styles.brandMark}>
          <InsightsIcon />
        </Box>
        <Box>
          <Typography variant="subtitle1" sx={{ lineHeight: 1.2 }}>
            品質レポート
          </Typography>
          <Typography variant="caption" color="text.secondary">
            分析プラットフォーム
          </Typography>
        </Box>
      </Box>

      <List sx={styles.navList}>
        {NAV_ITEMS.map((item) => {
          const selected = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <ListItem key={item.href} disablePadding>
              <ListItemButton
                component={Link}
                href={item.href}
                selected={selected}
                onClick={() => setMobileOpen(false)}
                sx={styles.navButton}
              >
                <ListItemIcon sx={{ minWidth: 40 }}>
                  <Icon />
                </ListItemIcon>
                <ListItemText
                  primary={item.label}
                  secondary={selected ? undefined : item.description}
                  slotProps={{
                    primary: { sx: { fontWeight: 600, fontSize: '0.95rem' } },
                    secondary: { noWrap: true, sx: { fontSize: '0.72rem' } },
                  }}
                />
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>

      <Box sx={{ p: 2 }}>
        <Chip
          label="PoC 環境"
          size="small"
          variant="outlined"
          color="primary"
          sx={{ width: '100%' }}
        />
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh' }}>
      <AppBar
        position="fixed"
        sx={{
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          ml: { md: `${DRAWER_WIDTH}px` },
          zIndex: (t) => t.zIndex.drawer + 1,
        }}
      >
        <Toolbar sx={{ gap: 1 }}>
          <IconButton
            edge="start"
            onClick={() => setMobileOpen(true)}
            sx={{ display: { md: 'none' } }}
            aria-label="メニューを開く"
          >
            <MenuIcon />
          </IconButton>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" noWrap>
              {APP_TITLE}
            </Typography>
            <Typography variant="h6" noWrap sx={{ lineHeight: 1.1 }}>
              {activeItem.label}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <ColorModeButton />
            <Avatar sx={{ width: 34, height: 34, bgcolor: 'primary.main', fontSize: 15 }}>
              QA
            </Avatar>
          </Stack>
        </Toolbar>
      </AppBar>

      <Box
        component="nav"
        sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}
      >
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: 'block', md: 'none' },
            '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
          }}
        >
          {drawerContent}
        </Drawer>
        <Drawer
          variant="permanent"
          open
          sx={{
            display: { xs: 'none', md: 'block' },
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              borderRight: (t) => `1px solid ${t.palette.divider}`,
            },
          }}
        >
          {drawerContent}
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          minWidth: 0,
        }}
      >
        <Toolbar />
        <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1400, mx: 'auto' }}>{children}</Box>
      </Box>
    </Box>
  );
}
