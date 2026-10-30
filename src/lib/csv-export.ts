// CSV-экспорт правок: точка с запятой (Excel ru-локаль), BOM, экранирование RFC 4180.
import type { Edit } from '@/lib/types';

const SEP = ';';
const HEADER = ['original', 'suggested', 'category', 'severity', 'confidence', 'source', 'decision', 'decided_by', 'reason'];

export function cell(v: string | number): string {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function editsToCsv(edits: Edit[]): string {
  const rows = edits.map((e) =>
    [e.original, e.suggested, e.category, e.severity, e.confidence, e.sourceModule, e.decision, e.decidedBy ?? '', e.reason]
      .map(cell)
      .join(SEP),
  );
  return '﻿' + [HEADER.join(SEP), ...rows].join('\n') + '\n';
}
