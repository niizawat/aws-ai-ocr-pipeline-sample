'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const markdownComponents: Components = {
  h1: ({ children }) => (
    <Typography variant="h6" component="h1" gutterBottom sx={{ mt: 1.5, mb: 0.5 }}>
      {children}
    </Typography>
  ),
  h2: ({ children }) => (
    <Typography
      variant="subtitle1"
      component="h2"
      gutterBottom
      sx={{ mt: 1.5, mb: 0.5, fontWeight: 700 }}
    >
      {children}
    </Typography>
  ),
  h3: ({ children }) => (
    <Typography
      variant="subtitle2"
      component="h3"
      gutterBottom
      sx={{ mt: 1, mb: 0.5, fontWeight: 700 }}
    >
      {children}
    </Typography>
  ),
  p: ({ children }) => (
    <Typography variant="body2" component="p" sx={{ mb: 1, '&:last-child': { mb: 0 } }}>
      {children}
    </Typography>
  ),
  ul: ({ children }) => (
    <Box component="ul" sx={{ m: 0, mb: 1, pl: 2.5 }}>
      {children}
    </Box>
  ),
  ol: ({ children }) => (
    <Box component="ol" sx={{ m: 0, mb: 1, pl: 2.5 }}>
      {children}
    </Box>
  ),
  li: ({ children }) => (
    <Typography component="li" variant="body2" sx={{ mb: 0.25 }}>
      {children}
    </Typography>
  ),
  strong: ({ children }) => (
    <Box component="strong" sx={{ fontWeight: 700 }}>
      {children}
    </Box>
  ),
  hr: () => (
    <Box
      component="hr"
      sx={{
        border: 0,
        borderTop: 1,
        borderColor: 'divider',
        my: 1.5,
      }}
    />
  ),
  table: ({ children }) => (
    <Box
      component="table"
      sx={{
        width: '100%',
        borderCollapse: 'collapse',
        mb: 1.5,
        fontSize: '0.8125rem',
        display: 'block',
        overflowX: 'auto',
      }}
    >
      {children}
    </Box>
  ),
  thead: ({ children }) => <Box component="thead">{children}</Box>,
  tbody: ({ children }) => <Box component="tbody">{children}</Box>,
  tr: ({ children }) => (
    <Box component="tr" sx={{ borderBottom: 1, borderColor: 'divider' }}>
      {children}
    </Box>
  ),
  th: ({ children }) => (
    <Box
      component="th"
      sx={{
        px: 1,
        py: 0.75,
        textAlign: 'left',
        fontWeight: 700,
        bgcolor: 'action.hover',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Box>
  ),
  td: ({ children }) => (
    <Box component="td" sx={{ px: 1, py: 0.75, verticalAlign: 'top' }}>
      {children}
    </Box>
  ),
};

interface MarkdownContentProps {
  content: string;
}

/** RAG 回答など Markdown テキストを MUI スタイルで表示する。 */
export default function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <Box sx={{ '& > *:first-of-type': { mt: 0 } }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </Box>
  );
}
