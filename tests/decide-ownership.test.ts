import { describe, it, expect } from 'vitest';
import { editBelongsToOrder, findAcceptedClash } from '@/lib/decide-guard';
import type { Edit } from '@/lib/types';

function mk(p: Partial<Edit>): Edit {
  return {
    id: 1, orderId: 5, spanStart: 0, spanEnd: 1, baseRevision: 1, original: 'x', suggested: 'y',
    contextBefore: '', contextAfter: '', category: 'spelling', severity: 'normal',
    confidence: 0.9, reason: 't', sourceModule: 'llm-pass', decision: 'pending', ...p,
  };
}

describe('защита приёмки: правка принадлежит заказу из URL', () => {
  it('пропускает правку своего заказа', () => {
    expect(editBelongsToOrder(mk({ orderId: 5 }), 5)).toBe(true);
  });

  it('блокирует правку чужого заказа (Codex risk #4)', () => {
    expect(editBelongsToOrder(mk({ orderId: 7 }), 5)).toBe(false);
  });

  it('блокирует несуществующую правку', () => {
    expect(editBelongsToOrder(undefined, 5)).toBe(false);
    expect(editBelongsToOrder(null as any, 5)).toBe(false);
  });
});

describe('защита приёмки: нельзя принять правку поверх уже принятой (пересечение span)', () => {
  it('находит уже принятую правку с пересекающимся span', () => {
    const target = mk({ id: 2, spanStart: 605, spanEnd: 686, decision: 'pending' });
    const accepted = mk({ id: 22, spanStart: 605, spanEnd: 686, decision: 'accepted' });
    const clash = findAcceptedClash(target, [accepted]);
    expect(clash?.id).toBe(22);
  });

  it('не считает клэшем саму себя и непересекающиеся/непринятые правки', () => {
    const target = mk({ id: 2, spanStart: 605, spanEnd: 686, decision: 'pending' });
    const self = mk({ id: 2, spanStart: 605, spanEnd: 686, decision: 'accepted' });
    const farAway = mk({ id: 3, spanStart: 900, spanEnd: 910, decision: 'accepted' });
    const rejectedOverlap = mk({ id: 4, spanStart: 610, spanEnd: 620, decision: 'rejected' });
    expect(findAcceptedClash(target, [self, farAway, rejectedOverlap])).toBeUndefined();
  });
});
