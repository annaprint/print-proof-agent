import { NextRequest, NextResponse } from 'next/server';
import { q } from '@/lib/db';
import { getCurrentUser, can, forbidden, unauthorized } from '@/lib/auth';

// Решения по правкам: поштучно, категорией, все сразу. Каждое решение пишется в протокол (decided_at/by).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return unauthorized();
  if (!can(me, 'decide')) return forbidden('приёмка правок доступна менеджеру и администратору');
  const MANAGER = me.name; // в протокол пишется реальный решивший
  const { id } = await params;
  const orderId = Number(id);
  const body = await req.json();
  const decision = body.decision as 'accepted' | 'rejected' | 'pending';

  // ownership-guard: правка/замечание из body должны принадлежать заказу из URL (Codex risk #4)
  const { editBelongsToOrder, layoutIssueBelongsToOrder } = await import('@/lib/decide-guard');
  if (body.editId) {
    const e = q.getEdit(Number(body.editId));
    if (!editBelongsToOrder(e, orderId)) return NextResponse.json({ error: 'правка не принадлежит заказу' }, { status: 403 });
  }
  if (body.layoutIssueId) {
    const li = q.listLayoutIssues(orderId).find((x) => x.id === Number(body.layoutIssueId));
    if (!layoutIssueBelongsToOrder(li, orderId)) return NextResponse.json({ error: 'замечание не принадлежит заказу' }, { status: 403 });
  }

  // ручная правка предложения: менеджер меняет «стало», решение сбрасывается в pending
  if (body.editId && typeof body.suggested === 'string') {
    const edit = q.getEdit(Number(body.editId));
    if (!edit) return NextResponse.json({ error: 'правка не найдена' }, { status: 404 });
    try {
      const updated = (await import('@/lib/edit-suggestion')).applySuggestionChange(edit, body.suggested);
      q.updateEditSuggestion(edit.id!, updated.suggested, updated.reason);
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message ?? e) }, { status: 400 });
    }
    return NextResponse.json({ edits: q.listEdits(orderId), pending: q.listEdits(orderId).filter((e) => e.decision === 'pending').length });
  }

  if (body.layoutIssueId) {
    q.decideLayoutIssue(Number(body.layoutIssueId), decision as 'accepted' | 'rejected');
  } else if (body.editId) {
    try {
      q.decideEdit(Number(body.editId), decision, MANAGER);
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message ?? e) }, { status: 409 });
    }
  } else if (body.category) {
    q.decideCategory(orderId, String(body.category), decision as 'accepted' | 'rejected', MANAGER);
  } else if (body.all) {
    q.decideAll(orderId, decision as 'accepted' | 'rejected', MANAGER);
  } else {
    return NextResponse.json({ error: 'укажите editId, category или all' }, { status: 400 });
  }

  const edits = q.listEdits(orderId);
  const pending = edits.filter((e) => e.decision === 'pending').length;
  if (pending === 0) q.updateOrderStatus(orderId, 'done');

  return NextResponse.json({ edits, pending });
}
