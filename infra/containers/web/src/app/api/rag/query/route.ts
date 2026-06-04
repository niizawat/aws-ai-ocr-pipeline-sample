import { ragQueryStream } from '@/lib/aws/rag';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let query: string;
  try {
    const body = (await request.json()) as { query?: string };
    query = body.query?.trim() ?? '';
    if (!query) {
      return new Response(JSON.stringify({ error: 'query は必須です。' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch {
    return new Response(JSON.stringify({ error: 'リクエストの解析に失敗しました。' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for await (const event of ragQueryStream(query)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        // error イベントはストリームを終了
        if (event.type === 'done' || event.type === 'error') break;
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
