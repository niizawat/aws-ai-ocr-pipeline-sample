'use client';

import * as React from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Avatar from '@mui/material/Avatar';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import SendIcon from '@mui/icons-material/SendRounded';
import SmartToyIcon from '@mui/icons-material/SmartToyRounded';
import PersonIcon from '@mui/icons-material/PersonRounded';

import PageHeader from '@/components/PageHeader';
import MarkdownContent from '@/components/MarkdownContent';
import type { RagStreamEvent } from '@/lib/aws/rag';
import type { RagReference } from '@/lib/types';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  references?: RagReference[];
}

const SUGGESTIONS = [
  '直近で多い不具合の傾向は？',
  '対策が完了していないレポートは？',
  '溶接に関する不具合の概要を教えて',
];

export default function SearchPage() {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const send = React.useCallback(
    async (text: string) => {
      const query = text.trim();
      if (!query || loading) return;
      setMessages((prev) => [...prev, { role: 'user', content: query }]);
      setInput('');
      setLoading(true);

      // SSE ストリーミング受信
      // assistant メッセージを空で先に追加し、delta ごとに追記する
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      try {
        const resp = await fetch('/api/rag/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });

        if (!resp.ok || !resp.body) {
          throw new Error(`リクエストに失敗しました (${resp.status.toString()})`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const json = line.slice(6).trim();
            if (!json) continue;

            const event = JSON.parse(json) as RagStreamEvent;

            if (event.type === 'refs') {
              // 参照情報を即座にセット
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === 'assistant') {
                  next[next.length - 1] = { ...last, references: event.refs };
                }
                return next;
              });
              setLoading(false);
            } else if (event.type === 'delta') {
              // テキストを追記
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === 'assistant') {
                  next[next.length - 1] = {
                    ...last,
                    content: last.content + event.text,
                  };
                }
                return next;
              });
              setLoading(false);
            } else if (event.type === 'error') {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === 'assistant') {
                  next[next.length - 1] = {
                    ...last,
                    content: `検索中にエラーが発生しました: ${event.message}`,
                  };
                }
                return next;
              });
            }
          }
        }
      } catch (e) {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') {
            next[next.length - 1] = {
              ...last,
              content: `検索中にエラーが発生しました: ${
                e instanceof Error ? e.message : '不明なエラー'
              }`,
            };
          }
          return next;
        });
      } finally {
        setLoading(false);
      }
    },
    [loading],
  );

  return (
    <Box>
      <PageHeader
        title="RAG 検索"
        description="品質レポートの内容を自然言語で検索・質問できます。"
      />

      <Paper
        variant="outlined"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          height: 'calc(100dvh - 240px)',
          minHeight: 420,
          overflow: 'hidden',
        }}
      >
        <Box sx={{ flex: 1, overflowY: 'auto', p: { xs: 2, md: 3 } }}>
          {messages.length === 0 && !loading && (
            <Stack spacing={2} sx={{ py: 6, color: 'text.secondary', alignItems: 'center' }}>
              <Avatar sx={{ bgcolor: 'primary.main', width: 56, height: 56 }}>
                <SmartToyIcon />
              </Avatar>
              <Typography variant="body1">
                品質レポートについて質問してください。
              </Typography>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ flexWrap: 'wrap', justifyContent: 'center' }}
              >
                {SUGGESTIONS.map((s) => (
                  <Chip
                    key={s}
                    label={s}
                    variant="outlined"
                    onClick={() => void send(s)}
                    sx={{ mb: 1 }}
                  />
                ))}
              </Stack>
            </Stack>
          )}

          <Stack spacing={2}>
            {messages.map((msg, idx) => (
              <MessageBubble key={idx} message={msg} />
            ))}
            {loading && (
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                <Avatar sx={{ bgcolor: 'primary.main', width: 32, height: 32 }}>
                  <SmartToyIcon fontSize="small" />
                </Avatar>
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  検索中...
                </Typography>
              </Stack>
            )}
            <div ref={endRef} />
          </Stack>
        </Box>

        <Box
          component="form"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          sx={{
            p: 1.5,
            borderTop: (t) => `1px solid ${t.palette.divider}`,
            display: 'flex',
            gap: 1,
          }}
        >
          <TextField
            fullWidth
            size="small"
            placeholder="品質レポートについて質問してください"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
          />
          <IconButton
            type="submit"
            color="primary"
            disabled={loading || !input.trim()}
            aria-label="送信"
          >
            <SendIcon />
          </IconButton>
        </Box>
      </Paper>
    </Box>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        flexDirection: isUser ? 'row-reverse' : 'row',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
      }}
    >
      <Avatar
        sx={{
          width: 32,
          height: 32,
          bgcolor: isUser ? 'secondary.main' : 'primary.main',
        }}
      >
        {isUser ? <PersonIcon fontSize="small" /> : <SmartToyIcon fontSize="small" />}
      </Avatar>
      <Box sx={{ maxWidth: '80%' }}>
        <Paper
          variant="outlined"
          sx={{
            px: 2,
            py: 1.25,
            bgcolor: isUser ? 'primary.main' : 'background.default',
            color: isUser ? 'primary.contrastText' : 'text.primary',
            borderColor: isUser ? 'primary.main' : 'divider',
          }}
        >
          {isUser ? (
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
              {message.content}
            </Typography>
          ) : (
            <MarkdownContent content={message.content} />
          )}
        </Paper>
        {message.references && message.references.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">
              参照元:
            </Typography>
            <Stack direction="row" spacing={0.5} useFlexGap sx={{ mt: 0.5, flexWrap: 'wrap' }}>
              {message.references.map((ref, i) => (
                <Chip
                  key={i}
                  size="small"
                  variant="outlined"
                  label={`${ref.reportId}${ref.reportDate ? ` (${ref.reportDate})` : ''}`}
                />
              ))}
            </Stack>
          </Box>
        )}
      </Box>
    </Stack>
  );
}
