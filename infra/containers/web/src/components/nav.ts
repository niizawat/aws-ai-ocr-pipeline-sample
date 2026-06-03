import DashboardIcon from '@mui/icons-material/SpaceDashboardRounded';
import SearchIcon from '@mui/icons-material/TravelExploreRounded';
import UploadIcon from '@mui/icons-material/CloudUploadRounded';
import DescriptionIcon from '@mui/icons-material/DescriptionRounded';
import FactCheckIcon from '@mui/icons-material/FactCheckRounded';
import type { SvgIconComponent } from '@mui/icons-material';

export interface NavItem {
  label: string;
  href: string;
  description: string;
  icon: SvgIconComponent;
}

export const NAV_ITEMS: NavItem[] = [
  {
    label: 'ダッシュボード',
    href: '/dashboard',
    description: '品質指標の全体像を可視化',
    icon: DashboardIcon,
  },
  {
    label: 'RAG 検索',
    href: '/search',
    description: '自然言語でレポートを横断検索',
    icon: SearchIcon,
  },
  {
    label: 'アップロード',
    href: '/upload',
    description: 'Excel / PDF を取り込み',
    icon: UploadIcon,
  },
  {
    label: 'レポート閲覧',
    href: '/reports',
    description: '元ファイルと抽出結果を確認',
    icon: DescriptionIcon,
  },
  {
    label: 'レビュー管理',
    href: '/reviews',
    description: 'A2I 人手レビューの状況',
    icon: FactCheckIcon,
  },
];

export const APP_TITLE = '品質レポート分析基盤';
