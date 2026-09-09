// Оркестрация каскада: rule-pass → llm-pass → vision-pass → resolver → БД.
// Запускается асинхронно после загрузки; статусы заказа отражают прогресс.
import { q } from '@/lib/db';
import { runRulePass } from '@/agent/rules';
import { runLlmPass } from '@/agent/proofread';
import { runVisionPass } from '@/agent/layout-inspect';
import { resolveEdits } from '@/agent/resolver';
import { selectAutoAccept } from '@/agent/auto-accept';
import { extractUsage, sumUsage, type Usage } from '@/lib/usage';
import { extractPdfGeometry, findAnchorBbox } from '@/agent/pdf-anchors';
import { normalizeFile, renderPdfPages } from '@/lib/normalize';
import fs from 'fs';
import path from 'path';

// Добор недостающих артефактов (parsed_text, page_render) из исходного файла.
// Нужен для заказов, загруженных до появления соответствующих фич.
async function backfillArtifacts(orderId: number, type: string): Promise<void> {
  const source = q.getArtifact(orderId, 'source');
  if (!source?.path || !fs.existsSync(source.path)) return;

  if (!q.getArtifact(orderId, 'parsed_text')) {
    const buffer = fs.readFileSync(source.path);
    const norm = await normalizeFile(path.basename(source.path), buffer);
    if (norm.text) q.saveArtifact(orderId, 'parsed_text', { content: norm.text });
  }

  if (type !== 'text' && q.listArtifacts(orderId, 'page_render').length === 0) {
    const buffer = fs.readFileSync(source.path);
    const renders = type === 'pdf' ? await renderPdfPages(buffer) : [];
    renders.forEach((render, i) => {
      const renderPath = path.join(process.cwd(), 'data', 'uploads', `${orderId}-page${i + 1}.png`);
      fs.writeFileSync(renderPath, render);
      q.saveArtifact(orderId, 'page_render', { path: renderPath });
    });
  }
}

export async function runCheck(orderId: number): Promise<void> {
  const order = q.getOrder(orderId);
  if (!order) throw new Error(`Заказ #${orderId} не найден`);

  q.updateOrderStatus(orderId, 'checking');
  // защита от повторного запуска: старые нерешённые правки убираем, решения менеджера не трогаем
  q.clearUndecidedEdits(orderId);
  try {
    const profile = q.getProfile(order.clientProfileId ?? null);

    // backfill: заказы, загруженные до появления извлечения текста / рендера страниц,
    // не имеют этих артефактов — добираем их из исходника при перепроверке (лечит старые заказы).
    await backfillArtifacts(orderId, order.type);

    const parsed = q.getArtifact(orderId, 'parsed_text');
    const text = parsed?.content ?? '';
    const usages: Usage[] = []; // фактический расход всех pass-ов

    if (text) {
      const t0 = Date.now();
      const ruleEdits = runRulePass(text, order.documentRevision, profile?.rules);
      const tRule = Date.now() - t0;

      const t1 = Date.now();
      const llmEdits = await runLlmPass(text, order.documentRevision, profile, (m) => usages.push(extractUsage(m)));
      const tLlm = Date.now() - t1;

      // после clearUndecidedEdits в БД остались только уже решённые менеджером правки —
      // их участки текста заблокированы для новых кандидатов (см. resolver.ts)
      const lockedSpans = q.listEdits(orderId)
        .filter((e) => e.decision !== 'pending')
        .map((e) => ({ spanStart: e.spanStart, spanEnd: e.spanEnd }));
      const resolved = resolveEdits([...ruleEdits, ...llmEdits], lockedSpans);
      q.insertEdits(orderId, resolved);

      // авто-принятие безопасных правок (opt-in профиля); менеджер может отменить до экспорта
      let autoAccepted = 0;
      if (profile?.rules.autoAccept) {
        const autoIdx = new Set(selectAutoAccept(resolved, profile.rules));
        const inserted = q.listEdits(orderId).filter((e) => e.decision === 'pending');
        inserted.forEach((e, i) => {
          if (autoIdx.has(i)) {
            q.decideEdit(e.id!, 'accepted', 'агент (авто)');
            autoAccepted++;
          }
        });
      }

      q.saveArtifact(orderId, 'protocol', {
        content: JSON.stringify({
          ruleMs: tRule, ruleCount: ruleEdits.length,
          llmMs: tLlm, llmCount: llmEdits.length,
          merged: ruleEdits.length + llmEdits.length - resolved.length,
          total: resolved.length,
          autoAccepted,
          usage: sumUsage(usages), // факт: токены и стоимость (дополнится vision-ом ниже)
        }),
      });
    }

    if (order.type !== 'text') {
      // для PDF vision смотрит на рендеры страниц (надёжнее, чем сырой PDF), для картинок — на исходник
      const renders = q.listArtifacts(orderId, 'page_render');
      const source = q.getArtifact(orderId, 'source');
      const targets: { path: string; page: number }[] =
        renders.length > 0
          ? renders.map((r, i) => ({ path: r.path!, page: i + 1 }))
          : source?.path
            ? [{ path: source.path, page: 1 }]
            : [];

      // страницы проверяются параллельно — многостраничный PDF не растягивает срок линейно
      const perPage = await Promise.all(
        targets.map(async ({ path: p, page }) => {
          const issues = await runVisionPass(p, (m) => usages.push(extractUsage(m)));
          for (const i of issues) i.page = page; // страница известна достоверно — не доверяем её модели
          return issues;
        }),
      );
      const issues = perPage.flat();

      // snap-to-text: для PDF уточняем bbox по точной геометрии текстового слоя соответствующей страницы
      if (order.type === 'pdf' && source?.path && fs.existsSync(source.path)) {
        const pdfBuffer = fs.readFileSync(source.path);
        const geomByPage = new Map<number, Awaited<ReturnType<typeof extractPdfGeometry>>>();
        for (const issue of issues) {
          if (!issue.anchorText) continue;
          if (!geomByPage.has(issue.page)) geomByPage.set(issue.page, await extractPdfGeometry(pdfBuffer, issue.page));
          const geom = geomByPage.get(issue.page);
          if (geom) {
            const snapped = findAnchorBbox(geom, issue.anchorText);
            if (snapped) issue.bbox = snapped;
          }
        }
      }
      q.insertLayoutIssues(orderId, issues);
    }

    // финализируем протокол с полным фактическим расходом (llm + vision по страницам)
    const proto = q.getArtifact(orderId, 'protocol');
    if (proto?.content) {
      const parsedProto = JSON.parse(proto.content);
      parsedProto.usage = sumUsage(usages);
      q.saveArtifact(orderId, 'protocol', { content: JSON.stringify(parsedProto) });
    } else if (usages.length) {
      q.saveArtifact(orderId, 'protocol', { content: JSON.stringify({ ruleMs: 0, ruleCount: 0, llmMs: 0, llmCount: 0, merged: 0, total: 0, autoAccepted: 0, usage: sumUsage(usages) }) });
    }

    q.updateOrderStatus(orderId, 'review');
  } catch (err: any) {
    q.updateOrderStatus(orderId, 'error', String(err?.message ?? err));
    throw err;
  }
}
