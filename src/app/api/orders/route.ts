import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { q } from '@/lib/db';
import { normalizeFile, countStats, renderPdfPages } from '@/lib/normalize';
import { estimateOrder } from '@/agent/estimate';
import { getCurrentUser, can, forbidden, unauthorized } from '@/lib/auth';

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return unauthorized();
  let orders = q.listOrders();
  // ACL: клиент видит только свои заказы; дизайнер — только заказы с заданиями по макету
  if (me.role === 'client') orders = orders.filter((o) => o.clientProfileId === me.clientProfileId);
  if (me.role === 'designer') orders = orders.filter((o) => q.listLayoutIssues(o.id!).length > 0);
  // прогресс llm-pass по частям — только для идущих проверок
  return NextResponse.json(orders.map((o) => {
    if (o.status !== 'checking') return o;
    const p = q.getArtifact(o.id!, 'llm_progress')?.content;
    return p ? { ...o, progress: JSON.parse(p) } : o;
  }));
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return unauthorized();
  if (!can(me, 'upload')) return forbidden('ваша роль не может загружать заказы');
  const form = await req.formData();
  const file = form.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'файл не передан' }, { status: 400 });

  // валидация до любой обработки: тип, размер, пустота
  const { validateUpload } = await import('@/lib/upload-validate');
  const valid = validateUpload(file.name, file.size);
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const norm = await normalizeFile(file.name, buffer);

  // профиль выбирается менеджером до загрузки; клиент всегда грузит в свой профиль
  const requestedProfileId =
    me.role === 'client' ? me.clientProfileId : form.get('profileId') ? Number(form.get('profileId')) : null;
  const profile = q.getProfile(requestedProfileId);
  const orderId = q.createOrder(file.name, norm.type, profile?.id ?? null);

  // сохраняем исходник и immutable-текст rev.1
  const uploadPath = path.join(process.cwd(), 'data', 'uploads', `${orderId}-${file.name}`);
  fs.writeFileSync(uploadPath, buffer);
  q.saveArtifact(orderId, 'source', { path: uploadPath });
  if (norm.text) q.saveArtifact(orderId, 'parsed_text', { content: norm.text });
  q.setTextHash(orderId, norm.hash);

  // PDF: рендерим все страницы (до лимита) в PNG — для vision-pass и предпросмотра с bbox-оверлеем
  let pages = 1;
  if (norm.type === 'pdf') {
    const renders = await renderPdfPages(buffer);
    renders.forEach((render, i) => {
      const renderPath = path.join(process.cwd(), 'data', 'uploads', `${orderId}-page${i + 1}.png`);
      fs.writeFileSync(renderPath, render);
      q.saveArtifact(orderId, 'page_render', { path: renderPath });
    });
    pages = Math.max(1, renders.length);
  }

  // мгновенная оценка: предсказуемость срока и цены
  const stats = countStats(norm.text);
  const estimate = estimateOrder(norm.type, stats.chars, pages);
  q.setEstimate(orderId, estimate);

  // детектор дубликатов: тот же текст уже проверялся — предупреждаем, но не блокируем
  const { findDuplicateOrder } = await import('@/lib/duplicate');
  const duplicateOf = findDuplicateOrder(q.listOrders() as any, norm.hash, orderId);

  // очередь: не больше CHECK_CONCURRENCY каскадов одновременно; лишние ждут со статусом queued
  const { planCheck } = await import('@/lib/queue');
  const activeChecking = q.listOrders().filter((o) => o.status === 'checking').length;
  if (planCheck(activeChecking) === 'queue') {
    q.updateOrderStatus(orderId, 'queued');
    return NextResponse.json({ id: orderId, estimate, status: 'queued', duplicateOf: duplicateOf ? { id: duplicateOf.id, filename: duplicateOf.filename } : null });
  }

  // каскад — в отдельном процессе: LLM-вызов SDK не должен блокировать event loop сервера
  const worker = spawn('npx', ['tsx', 'scripts/run-check.ts', String(orderId)], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
  });
  worker.unref();

  return NextResponse.json({ id: orderId, estimate, status: 'estimated', duplicateOf: duplicateOf ? { id: duplicateOf.id, filename: duplicateOf.filename } : null });
}
