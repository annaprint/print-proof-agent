import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { q } from '@/lib/db';
import { highlightPdf } from '@/agent/pdf-highlight';
import { withoutYo } from '@/lib/yo-edit';
import { getCurrentUser, can, forbidden, unauthorized } from '@/lib/auth';

// Исходный PDF с подсветкой мест правок (без отклонённых менеджером и без замен е→ё) — для дизайнера.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return unauthorized();
  if (!can(me, 'view_layout_tasks')) return forbidden('PDF с подсветкой доступен менеджеру, дизайнеру и администратору');

  const { id } = await params;
  const orderId = Number(id);
  const order = q.getOrder(orderId);
  if (!order) return NextResponse.json({ error: 'не найден' }, { status: 404 });
  if (order.type !== 'pdf') return NextResponse.json({ error: 'подсветка доступна только для PDF-заказов' }, { status: 400 });

  const source = q.getArtifact(orderId, 'source');
  if (!source?.path || !fs.existsSync(source.path)) return NextResponse.json({ error: 'исходник не найден' }, { status: 404 });

  const baseText = q.getArtifact(orderId, 'parsed_text')?.content ?? '';
  const { pdf, highlighted, unmatched } = await highlightPdf(fs.readFileSync(source.path), withoutYo(q.listEdits(orderId)), baseText);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="highlighted-${orderId}.pdf"`,
      'X-Highlighted': String(highlighted),
      'X-Unmatched': String(unmatched.length),
    },
  });
}
