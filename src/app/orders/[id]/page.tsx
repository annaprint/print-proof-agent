'use client';
// Экран «Приёмка» (вариант A, split view): документ с подчёркнутыми предложениями агента слева,
// правки по категориям справа. Provenance-тултипы на каждой правке и кнопке.
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { filterEdits, type EditFilter } from '@/lib/edit-filter';
import { buildFinalSegments } from '@/lib/final-preview';
import { searchEdits, sortEdits, type SortMode } from '@/lib/search-sort';
import { diffWords } from '@/lib/word-diff';
import { mapKeyToAction } from '@/lib/hotkeys';
import { costDelta } from '@/lib/cost-delta';

interface Edit {
  id: number;
  spanStart: number;
  spanEnd: number;
  original: string;
  suggested: string;
  category: string;
  severity: string;
  confidence: number;
  reason: string;
  sourceModule: string;
  decision: 'pending' | 'accepted' | 'rejected';
  decidedBy?: string | null;
  decidedAt?: string | null;
}

interface OrderData {
  order: { id: number; filename: string; status: string; documentRevision: number; type: string };
  renderPages: number;
  text: string;
  edits: Edit[];
  layoutIssues: {
    id: number; page: number; blockHint: string; description: string; severity: string; confidence: number;
    bbox: { x: number; y: number; w: number; h: number } | null;
    decision: 'pending' | 'accepted' | 'rejected';
  }[];
  profile: { name: string } | null;
  protocol: {
    ruleMs: number; ruleCount: number; llmMs: number; llmCount: number; merged: number; total: number;
    autoAccepted?: number;
    usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  } | null;
}

const CAT_LABEL: Record<string, string> = {
  spelling: 'Орфография',
  punctuation: 'Пунктуация',
  typography: 'Типографика',
  style: 'Стиль',
};
const MODULE_LABEL: Record<string, string> = {
  'rule-pass': 'rule-pass · детерминированное правило, 0 токенов',
  'llm-pass': 'llm-pass · Claude, корректорский проход',
  profile: 'профиль клиента · правило из словаря',
  'vision-pass': 'vision-pass · проверка макета',
};

function Tip({ children, tip }: { children: React.ReactNode; tip: React.ReactNode }) {
  return (
    <span className="tip">
      {children}
      <span className="tipbox">{tip}</span>
    </span>
  );
}

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<OrderData | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [showSource, setShowSource] = useState(true); // предпросмотр макета: скрываемый
  const [showBoxes, setShowBoxes] = useState(true); // замечания прямо на макете (опционально)
  const [blinkId, setBlinkId] = useState<number | null>(null); // мигающая цель навигации
  const [blinkIssueId, setBlinkIssueId] = useState<number | null>(null); // мигающее замечание макета
  const [editFilter, setEditFilter] = useState<EditFilter>({ decision: 'all', category: 'all' }); // фильтр правок
  const [showFinal, setShowFinal] = useState(false); // предпросмотр итогового текста
  const [query, setQuery] = useState(''); // поиск по правкам
  const [sortMode, setSortMode] = useState<SortMode>('position'); // сортировка правок

  // клик по bbox на макете → скролл и подсветка замечания в списке
  const focusIssue = useCallback((issueId: number) => {
    setBlinkIssueId(null);
    window.setTimeout(() => {
      document.getElementById(`li-${issueId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setBlinkIssueId(issueId);
    }, 30);
  }, []);

  // Навигация по правкам: клик на правку в панели скроллит к месту в документе,
  // клик на подсветку в документе — к карточке правки. ‹ › листают по порядку документа.
  const scrollTo = useCallback((id: number, target: 'doc' | 'card') => {
    setSelected(id);
    // мигание через state (а не classList): переживает ре-рендеры React.
    // Сброс → установка в следующем тике перезапускает CSS-анимацию при повторном клике.
    setBlinkId(null);
    window.setTimeout(() => {
      document.getElementById(`${target}-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setBlinkId(id);
    }, 30);
    window.setTimeout(() => setBlinkId((cur) => (cur === id ? null : cur)), 1400);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch(`/api/orders/${id}`);
    if (res.ok) setData(await res.json());
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function decide(body: Record<string, unknown>) {
    await fetch(`/api/orders/${id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    load();
  }

  // хоткеи: j/k — навигация, a/r — решение по выбранной (работают и в кириллице)
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const action = mapKeyToAction(ev.key);
      if (!action || !data) return;
      ev.preventDefault();
      const ordered = [...data.edits].sort((a, b) => a.spanStart - b.spanStart);
      const idx = ordered.findIndex((e) => e.id === selected);
      if (action.type === 'next' || action.type === 'prev') {
        const ni = action.type === 'next' ? (idx + 1) % ordered.length : (idx <= 0 ? ordered.length - 1 : idx - 1);
        if (ordered[ni]) scrollTo(ordered[ni].id, 'doc');
      } else if (selected != null) {
        decide({ editId: selected, decision: action.type === 'accept' ? 'accepted' : 'rejected' });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selected, scrollTo]);

  const pending = useMemo(() => data?.edits.filter((e) => e.decision === 'pending').length ?? 0, [data]);
  const accepted = useMemo(() => data?.edits.filter((e) => e.decision === 'accepted').length ?? 0, [data]);

  // документ с подсветкой правок (по span'ам immutable-базы)
  const docParts = useMemo(() => {
    if (!data) return null;
    const sorted = [...data.edits].sort((a, b) => a.spanStart - b.spanStart);
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    for (const e of sorted) {
      if (e.spanStart < cursor) continue;
      parts.push(<span key={`t${cursor}`}>{data.text.slice(cursor, e.spanStart)}</span>);
      parts.push(
        <Tip
          key={`e${e.id}`}
          tip={
            <>
              <div>{MODULE_LABEL[e.sourceModule] ?? e.sourceModule}</div>
              <div className="dim">основание: {e.reason}</div>
              <div className="dim">
                уверенность {Math.round(e.confidence * 100)}% · «{e.original}» → «{e.suggested}» · статус:{' '}
                {e.decision === 'pending' ? 'ожидает решения' : e.decision === 'accepted' ? `принята (${e.decidedBy})` : `отклонена (${e.decidedBy})`}
              </div>
            </>
          }
        >
          <span
            id={`doc-${e.id}`}
            className={`hl ${e.decision} ${e.severity === 'important' ? 'important' : ''} ${blinkId === e.id ? 'blink' : ''}`}
            onClick={() => scrollTo(e.id, 'card')}
            onAnimationEnd={() => setBlinkId((cur) => (cur === e.id ? null : cur))}
          >
            {e.original}
          </span>
        </Tip>,
      );
      cursor = e.spanEnd;
    }
    parts.push(<span key="tail">{data.text.slice(cursor)}</span>);
    return parts;
  }, [data, scrollTo, blinkId]);

  if (!data) return <div className="wrap">Загрузка…</div>;

  const { order, edits, profile, protocol, layoutIssues } = data;
  const cats = Array.from(new Set(edits.map((e) => e.category)));
  const sel = edits.find((e) => e.id === selected);

  return (
    <div className="wrap">
      <header className="masthead">
        <Link className="brand" href="/">PrintProof</Link>
        <Link href="/">← Заказы</Link>
        <Link href="/profiles">Профили</Link>
        <span>#{order.id} · {order.filename}</span>
        <span className="ctx">{profile ? `Профиль: «${profile.name}»` : ''}</span>
      </header>
      <hr className="rule-double" />
      <hr className="rule-thin" />

      <div className="progress">
        <Tip
          tip={
            protocol ? (
              <>
                <div>КАК ПРОШЛА ПРОВЕРКА (агент, автономно)</div>
                <div className="dim">rule-pass {protocol.ruleMs} мс · {protocol.ruleCount} правок</div>
                <div className="dim">llm-pass (Claude) {(protocol.llmMs / 1000).toFixed(1)} с · {protocol.llmCount} правок</div>
                <div className="dim">resolver: {protocol.ruleCount + protocol.llmCount} → {protocol.total} ({protocol.merged} слито)</div>
                {(protocol.autoAccepted ?? 0) > 0 && <div className="dim">авто-принято: {protocol.autoAccepted} (безопасные rule-pass)</div>}
                {protocol.usage && protocol.usage.inputTokens > 0 && (
                  <div className="dim">
                    факт. расход: {protocol.usage.inputTokens.toLocaleString('ru')} ток. вход + {protocol.usage.outputTokens.toLocaleString('ru')} выход · ${protocol.usage.costUsd.toFixed(4)}
                  </div>
                )}
                {(() => {
                  // оценка vs факт: насколько прогноз попал
                  const cd = costDelta((data as any).order?.estimate?.breakdown, protocol.usage?.costUsd ? { costUsd: protocol.usage.costUsd } : null, 0.92);
                  return cd ? (
                    <div className="dim">
                      оценка €{cd.estimateEur.toFixed(4)} vs факт €{cd.actualEur.toFixed(4)} ({cd.deltaPct > 0 ? '+' : ''}{cd.deltaPct}%)
                    </div>
                  ) : null;
                })()}
              </>
            ) : 'протокол проверки недоступен'
          }
        >
          <span className="mono" style={{ cursor: 'help' }}>
            принято <b className="status-green">{accepted}</b> / {edits.length} · осталось решить{' '}
            <b className="status-amber">{pending}</b>
          </span>
        </Tip>
        <div className="bar"><div style={{ width: edits.length ? `${(accepted / edits.length) * 100}%` : '0%' }} /></div>
        <span className="edit-nav mono">
          {(() => {
            const ordered = [...edits].sort((a, b) => a.spanStart - b.spanStart);
            const idx = ordered.findIndex((e) => e.id === selected);
            const goto = (i: number) => {
              const e = ordered[(i + ordered.length) % ordered.length];
              scrollTo(e.id, 'doc');
            };
            return (
              <>
                <Tip tip={<><div>предыдущая правка по тексту</div><div className="dim">скролл к месту в документе</div></>}>
                  <button className="navbtn" onClick={() => goto(idx <= 0 ? ordered.length - 1 : idx - 1)}>‹</button>
                </Tip>
                <span style={{ minWidth: '3.5rem', textAlign: 'center' }}>
                  {idx >= 0 ? `${idx + 1} / ${ordered.length}` : `— / ${ordered.length}`}
                </span>
                <Tip tip={<><div>следующая правка по тексту</div><div className="dim">скролл к месту в документе</div></>}>
                  <button className="navbtn" onClick={() => goto(idx + 1)}>›</button>
                </Tip>
              </>
            );
          })()}
        </span>
        <span className="footnote hide-mobile" style={{ marginLeft: 'auto' }}>экспорт откроется после решения по всем правкам</span>
      </div>

      <div className="review-grid">
        <div>
          {order.type !== 'text' && (
            <div className="source-block">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8rem' }}>
                <span className="label">исходный макет · {order.filename}</span>
                {order.type === 'pdf' && (
                  <a className="act" style={{ fontSize: '0.85rem' }} href={`/api/orders/${order.id}/source`} target="_blank">
                    открыть PDF ↗
                  </a>
                )}
                <Tip tip={<><div>{showSource ? 'скрыть' : 'показать'} предпросмотр макета</div><div className="dim">замечания vision-pass ссылаются на области этого изображения</div></>}>
                  <button className="linkish" onClick={() => setShowSource((s) => !s)}>
                    {showSource ? 'скрыть макет ▴' : 'показать макет ▾'}
                  </button>
                </Tip>
              </div>
              {showSource && layoutIssues.some((li) => li.bbox) && (
                <Tip tip={<><div>{showBoxes ? 'скрыть' : 'показать'} рамки замечаний на макете</div><div className="dim">bbox от vision-pass · номера совпадают со списком ниже</div></>}>
                  <button className="linkish" style={{ marginLeft: '0.8rem' }} onClick={() => setShowBoxes((s) => !s)}>
                    {showBoxes ? 'замечания на макете: вкл' : 'замечания на макете: выкл'}
                  </button>
                </Tip>
              )}
              {/* PDF без рендеров (нельзя показать <img>): только ссылка на оригинал */}
              {showSource && order.type === 'pdf' && data.renderPages === 0 && (
                <p className="footnote" style={{ marginTop: '0.6rem' }}>
                  Предпросмотр недоступен — <a className="act" href={`/api/orders/${order.id}/source`} target="_blank">открыть PDF ↗</a>. Перепроверьте заказ, чтобы отрендерить страницы.
                </p>
              )}
              {showSource &&
                // макет: для PDF — рендеры страниц со своими bbox; картинка — одна «страница» (pageNo=0)
                (data.renderPages > 0
                  ? Array.from({ length: data.renderPages }, (_, k) => k + 1)
                  : order.type === 'pdf'
                    ? []
                    : [0]
                ).map((pageNo) => (
                <div className="source-wrap" key={pageNo}>
                  {data.renderPages > 1 && <div className="label" style={{ margin: '0.5rem 0 0.2rem' }}>стр. {pageNo} из {data.renderPages}</div>}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="source-img"
                    src={`/api/orders/${order.id}/source${pageNo > 0 ? `?render=${pageNo}` : ''}`}
                    alt={`Исходный макет: ${order.filename}${pageNo > 0 ? `, стр. ${pageNo}` : ''}`}
                  />
                  {showBoxes &&
                    layoutIssues.map((li, i) =>
                      li.bbox && (pageNo === 0 || li.page === pageNo) ? (
                        <div
                          key={li.id}
                          className={`bbox ${li.severity === 'important' ? 'important' : ''} ${li.decision}`}
                          style={{
                            left: `${li.bbox.x / 10}%`,
                            top: `${li.bbox.y / 10}%`,
                            width: `${li.bbox.w / 10}%`,
                            height: `${li.bbox.h / 10}%`,
                          }}
                          onClick={() => focusIssue(li.id)}
                        >
                          <span className="bbox-num mono">{i + 1}</span>
                          {/* hover-поповер: текст замечания + быстрые решения */}
                          <div className="bbox-pop" onClick={(e) => e.stopPropagation()}>
                            <div className="bbox-pop-text">
                              <b>№{i + 1} · {li.blockHint}</b>
                              <div>{li.description}</div>
                            </div>
                            <div className="bbox-pop-actions">
                              <button
                                className="dec yes" disabled={li.decision === 'accepted'}
                                onClick={() => decide({ layoutIssueId: li.id, decision: 'accepted' })}
                              >✓ принять</button>
                              <button
                                className="dec no" disabled={li.decision === 'rejected'}
                                onClick={() => decide({ layoutIssueId: li.id, decision: 'rejected' })}
                              >✗ отклонить</button>
                              <span className="mono" style={{ fontSize: '10px', color: '#aaa' }}>
                                {li.decision === 'pending' ? 'ожидает' : li.decision === 'accepted' ? '✓ принято' : '✗ отклонено'}
                              </span>
                            </div>
                          </div>
                        </div>
                      ) : null,
                    )}
                </div>
              ))}
            </div>
          )}
          {data.text && (
            <>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'baseline' }}>
                <div className="label">
                  {showFinal ? 'итоговый текст · как будет после экспорта' : `документ · rev.${order.documentRevision} · подчёркнуто — предложения агента`}
                </div>
                <Tip tip={<><div>{showFinal ? 'вернуться к правкам' : 'предпросмотр результата'}</div><div className="dim">зелёное — применённые правки, жёлтое — ещё без решения</div></>}>
                  <button className="linkish" onClick={() => setShowFinal((s) => !s)}>
                    {showFinal ? '← к правкам' : 'итоговый текст →'}
                  </button>
                </Tip>
              </div>
              {showFinal ? (
                <div className="doc-pane" style={{ marginTop: '0.8rem' }}>
                  {buildFinalSegments(data.text, edits as any).map((s, i) =>
                    s.type === 'kept' ? <span key={i}>{s.text}</span> : (
                      <span key={i} className={s.type === 'replaced' ? 'seg-replaced' : 'seg-pending'}>{s.text}</span>
                    ),
                  )}
                </div>
              ) : (
                <div className="doc-pane" style={{ marginTop: '0.8rem' }}>{docParts}</div>
              )}
            </>
          )}

          {sel && (
            <div className="diffbox">
              <div className="label">выбранная правка · {CAT_LABEL[sel.category] ?? sel.category} · {sel.sourceModule}</div>
              <div className="diff-cols">
                <div className="diff-col minus">
                  <div className="label">− было</div>
                  <div>{sel.original}</div>
                </div>
                <div className="diff-col plus">
                  <div className="label">+ стало</div>
                  <div>{sel.suggested}</div>
                </div>
              </div>
              <div className="footnote" style={{ marginTop: '0.3rem' }}>
                {sel.reason} · уверенность {Math.round(sel.confidence * 100)}% · применится к ревизии rev.{order.documentRevision}
              </div>
            </div>
          )}

        </div>

        <div className="edits-pane">
          {layoutIssues.length > 0 && (
            <div style={{ marginBottom: '1.5rem' }}>
              <div className="cat-head" style={{ marginTop: 0 }}>
                <h3>Замечания по макету</h3>
                <span className="mono meta">{layoutIssues.length} · vision-pass</span>
                <span className="cat-act">
                  <Tip tip={<><div>скачать markdown-чеклист для дизайнера</div><div className="dim">страницы, области, важность; без отклонённых</div></>}>
                    <a className="act" style={{ fontSize: '0.9rem' }} href={`/api/orders/${order.id}/designer-task`}>задание дизайнеру ↓</a>
                  </Tip>
                </span>
              </div>
              {layoutIssues.map((li, i) => (
                <div
                  key={li.id}
                  id={`li-${li.id}`}
                  className={`issue-row ${li.decision} ${blinkIssueId === li.id ? 'blink' : ''}`}
                  onAnimationEnd={() => setBlinkIssueId((cur) => (cur === li.id ? null : cur))}
                >
                  <div style={{ flex: 1 }}>
                    {li.bbox && <span className="bbox-ref mono">{i + 1}</span>}{' '}
                    <span className={li.severity === 'important' ? 'status-red' : ''}>стр. {li.page}, {li.blockHint}:</span>{' '}
                    {li.description} <span className="mono footnote">({Math.round(li.confidence * 100)}%)</span>
                  </div>
                  <button className="dec yes" disabled={li.decision === 'accepted'} onClick={() => decide({ layoutIssueId: li.id, decision: 'accepted' })}>✓</button>
                  <button className="dec no" disabled={li.decision === 'rejected'} onClick={() => decide({ layoutIssueId: li.id, decision: 'rejected' })}>✗</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8rem', flexWrap: 'wrap' }}>
            <h2 style={{ fontWeight: 400, fontSize: '1.2rem' }}>Правки <span className="mono" style={{ fontSize: '0.85rem', color: 'var(--ink-muted)' }}>{edits.length}</span></h2>
            <Tip tip={<><div>перепроверить заказ агентом</div><div className="dim">после изменения профиля/словаря; ваши решения сохранятся</div></>}>
              <button
                className="linkish"
                onClick={async () => {
                  const r = await fetch(`/api/orders/${id}/recheck`, { method: 'POST' });
                  if (!r.ok) alert((await r.json()).error);
                  else { alert('Перепроверка запущена'); setTimeout(load, 2000); }
                }}
              >↻ перепроверить</button>
            </Tip>
            <Tip tip={<><div>действие: {pending} нерешённых правок → accepted</div><div className="dim">запись в протокол приёмки · отменяемо до экспорта</div></>}>
              <button className="linkish" style={{ color: 'var(--green)' }} disabled={!pending} onClick={() => decide({ all: true, decision: 'accepted' })}>✓ принять все</button>
            </Tip>
            <Tip tip={<><div>действие: {pending} нерешённых правок → rejected</div><div className="dim">запись в протокол приёмки</div></>}>
              <button className="linkish" style={{ color: 'var(--red)' }} disabled={!pending} onClick={() => decide({ all: true, decision: 'rejected' })}>✗ отклонить все</button>
            </Tip>
          </div>

          {/* фильтр правок: статус решения × категория */}
          <div className="edit-filters">
            {([['all', 'все'], ['pending', 'ожидают'], ['accepted', 'приняты'], ['rejected', 'отклонены'], ['important', 'важные']] as const).map(([k, l]) => (
              <button
                key={k}
                className={`filter-chip ${editFilter.decision === k ? 'active' : ''}`}
                onClick={() => setEditFilter({ ...editFilter, decision: k })}
              >{l} <span className="mono">{filterEdits(edits as any, { decision: k, category: editFilter.category }).length}</span></button>
            ))}
            <select
              className="pe-input" style={{ width: 'auto' }}
              value={editFilter.category}
              onChange={(e) => setEditFilter({ ...editFilter, category: e.target.value })}
            >
              <option value="all">все категории</option>
              {cats.map((c) => <option key={c} value={c}>{CAT_LABEL[c] ?? c}</option>)}
            </select>
            <input
              className="pe-input" style={{ width: '130px' }}
              placeholder="поиск…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Tip tip={<><div>сортировка списка правок</div><div className="dim">«сомнительные» — по возрастанию уверенности</div></>}>
              <select className="pe-input" style={{ width: 'auto' }} value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
                <option value="position">по тексту</option>
                <option value="confidence">сомнительные</option>
                <option value="severity">важные сверху</option>
              </select>
            </Tip>
          </div>

          {cats.map((cat) => {
            const catEdits = sortEdits(
              searchEdits(filterEdits(edits as any, editFilter), query),
              sortMode,
            ).filter((e) => e.category === cat) as typeof edits;
            if (catEdits.length === 0) return null;
            const catPending = catEdits.filter((e) => e.decision === 'pending').length;
            const modules = Array.from(new Set(catEdits.map((e) => e.sourceModule))).join(', ');
            return (
              <div key={cat}>
                <div className="cat-head">
                  <h3>{CAT_LABEL[cat] ?? cat}</h3>
                  <span className="mono meta">{catEdits.length} · {modules}</span>
                  <span className="cat-act">
                    <Tip tip={<><div>действие: {catPending} правок категории → accepted одним кликом</div><div className="dim">{`UPDATE edits SET decision='accepted' WHERE category='${cat}'`}</div></>}>
                      <button className="linkish" style={{ color: 'var(--green)' }} disabled={!catPending} onClick={() => decide({ category: cat, decision: 'accepted' })}>
                        принять категорию ✓
                      </button>
                    </Tip>
                  </span>
                </div>
                {catEdits.map((e) => (
                  <div
                    key={e.id} id={`card-${e.id}`}
                    className={`edit-card ${selected === e.id ? 'selected' : ''} ${blinkId === e.id ? 'blink' : ''}`}
                    onAnimationEnd={() => setBlinkId((cur) => (cur === e.id ? null : cur))}
                  >
                    <div className="body" onClick={() => scrollTo(e.id, 'doc')}>
                      <div className="change">
                        {(() => {
                          // word-diff: посимвольно видно, что меняется
                          const d = diffWords(e.original, e.suggested);
                          return (
                            <>
                              <span className="del">{d.prefix}{d.removed ? <b>{d.removed}</b> : <span className="del-caret">∅</span>}{d.suffix}</span>
                              {' → '}
                              <span className="ins">{d.prefix}<b>{d.added || '∅'}</b>{d.suffix}</span>
                            </>
                          );
                        })()}
                        {e.severity === 'important' && <span className="mono status-red" style={{ fontSize: '10px' }}> · важная</span>}
                      </div>
                      <div className="prov">
                        {e.sourceModule} · {Math.round(e.confidence * 100)}% ·{' '}
                        {e.decision === 'pending' ? 'ожидает' : e.decision === 'accepted' ? `✓ ${e.decidedBy}` : `✗ ${e.decidedBy}`}
                      </div>
                    </div>
                    <Tip tip={<><div>изменить предложение</div><div className="dim">новое «стало» потребует нового решения</div></>}>
                      <button
                        className="dec" style={{ color: 'var(--ink-muted)' }}
                        onClick={() => {
                          const s = window.prompt('Изменить предложение («стало»):', e.suggested);
                          if (s != null) decide({ editId: e.id, suggested: s });
                        }}
                      >✎</button>
                    </Tip>
                    <Tip tip={<><div>принять: decision=accepted</div><div className="dim">войдёт в экспорт · в протокол: {`«${e.original}» → «${e.suggested}»`}</div></>}>
                      <button className="dec yes" disabled={e.decision === 'accepted'} onClick={() => decide({ editId: e.id, decision: 'accepted' })}>✓</button>
                    </Tip>
                    <Tip tip={<><div>отклонить: decision=rejected</div><div className="dim">не войдёт в экспорт · фиксируется в протоколе</div></>}>
                      <button className="dec no" disabled={e.decision === 'rejected'} onClick={() => decide({ editId: e.id, decision: 'rejected' })}>✗</button>
                    </Tip>
                  </div>
                ))}
              </div>
            );
          })}

          <div className="export-row">
            <Tip
              tip={
                pending
                  ? <><div>недоступно: {pending} правок без решения</div><div className="dim">guardrail: экспорт только после решения по всем правкам</div></>
                  : <><div>сборка текста из accepted-правок по rev.{order.documentRevision}</div><div className="dim">курсор по immutable-базе, без сдвига offsets</div></>
              }
            >
              <a className={pending ? '' : 'act'} style={pending ? { color: 'var(--rule)', pointerEvents: 'none' } : {}} href={`/api/orders/${id}/export?format=docx`}>Экспорт DOCX</a>
            </Tip>
            <a className={pending ? '' : 'act'} style={pending ? { color: 'var(--rule)', pointerEvents: 'none' } : {}} href={`/api/orders/${id}/export?format=md`}>Markdown</a>
            <a className={pending ? '' : 'act'} style={pending ? { color: 'var(--rule)', pointerEvents: 'none' } : {}} href={`/api/orders/${id}/export?format=protocol`}>Протокол</a>
            <Tip tip={<><div>все правки в CSV (Excel)</div><div className="dim">включая решения и provenance; доступно в любой момент</div></>}>
              <a className="act" href={`/api/orders/${id}/edits.csv`}>CSV</a>
            </Tip>
            <Tip tip={<><div>список правок для дизайнера (CSV)</div><div className="dim">со страницами и контекстом, без отклонённых; доступен в любой момент</div></>}>
              <a className="act" href={`/api/orders/${id}/designer-edits`}>Правки для дизайнера</a>
            </Tip>
            {order.type === 'pdf' && (
              <Tip tip={<><div>PDF книги с подсвеченными правками</div><div className="dim">цвет по типу, в комментарии «было → стало»; без отклонённых и без замен е→ё</div></>}>
                <a className="act" href={`/api/orders/${id}/highlighted-pdf`}>PDF с подсветкой</a>
              </Tip>
            )}
            <Tip tip={<><div>полный архив заказа (JSON)</div><div className="dim">текст, правки, протокол, профиль — для долговременного хранения</div></>}>
              <a className="act" href={`/api/orders/${id}/archive`}>Архив</a>
            </Tip>
          </div>
          {pending > 0 && <p className="footnote" style={{ marginTop: '0.4rem' }}>кнопки активируются, когда решены все {edits.length} правок</p>}
        </div>
      </div>

      <div className="journal">
        наведите на подчёркнутые фрагменты, кнопки и прогресс — provenance каждой правки: какой модуль, на каком основании, что сделает клик
      </div>
    </div>
  );
}
