import { NextRequest, NextResponse } from 'next/server';
import { q } from '@/lib/db';
import { designerEditsCsv } from '@/lib/designer-edits';
import { getCurrentUser, can, forbidden, unauthorized } from '@/lib/auth';

// Список правок с номерами страниц для ручного внесения дизайнером (без отклонённых менеджером).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return unauthorized();
  if (!can(me, 'view_layout_tasks')) return forbidden('список правок для дизайнера доступен менеджеру, дизайнеру и администратору');

  const { id } = await params;
  const orderId = Number(id);
  if (!q.getOrder(orderId)) return NextResponse.json({ error: 'не найден' }, { status: 404 });

  const baseText = q.getArtifact(orderId, 'parsed_text')?.content ?? '';
  const csv = designerEditsCsv(q.listEdits(orderId), baseText);
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="designer-edits-${orderId}.csv"`,
    },
  });
}
