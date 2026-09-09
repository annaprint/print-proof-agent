// Защита приёмки: правка из тела запроса должна принадлежать заказу из URL.
// Иначе менеджер заказа A мог бы менять решения по правкам заказа B (Codex risk #4).
import type { Edit, LayoutIssue } from '@/lib/types';

export function editBelongsToOrder(edit: Edit | undefined | null, orderId: number): boolean {
  return !!edit && edit.orderId === orderId;
}

export function layoutIssueBelongsToOrder(issue: LayoutIssue | undefined | null, orderId: number): boolean {
  return !!issue && issue.orderId === orderId;
}

// Защита приёмки: нельзя принять правку, чей span пересекается с уже принятой
// правкой того же заказа — иначе на экспорте всплывёт "правки пересекаются"
// (см. export.ts). Ловит случай, когда менеджер вручную повторно принимает
// старую/отклонённую правку, не зная, что участок текста уже решён другой.
export function findAcceptedClash(edit: Edit, otherEdits: Edit[]): Edit | undefined {
  return otherEdits.find(
    (o) => o.id !== edit.id && o.decision === 'accepted' && o.spanStart < edit.spanEnd && edit.spanStart < o.spanEnd,
  );
}
