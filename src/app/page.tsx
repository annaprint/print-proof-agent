'use client';
// Экран «Заказы»: drag-drop загрузка + таблица с оценкой и статусами (прототип screen1-orders.svg)
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { UserBar, useMe } from '@/components/UserBar';
import { slaStatus } from '@/lib/sla';

interface OrderRow {
  id: number;
  filename: string;
  type: string;
  status: string;
  estimate: {
    chars: number; etaMinutes: number; priceEur: number;
    breakdown?: {
      model: string; inputTokens: number; outputTokens: number; tokenCostEur: number;
      modelPriceInUsdPerMTok: number; modelPriceOutUsdPerMTok: number; tariffEur: number; formula: string;
    };
  } | null;
  createdAt: string;
  error?: string | null;
  clientProfileId?: number | null;
  progress?: { done: number; total: number };
}

interface ProfileOption { id: number; name: string }

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  uploaded: { text: '○ загружен', cls: 'status-blue' },
  estimated: { text: '◐ оценён, запускается', cls: 'status-blue' },
  queued: { text: '⏸ в очереди', cls: 'status-amber' },
  checking: { text: '◐ проверка…', cls: 'status-blue' },
  review: { text: '● на приёмке', cls: 'status-amber' },
  done: { text: '✓ готов', cls: 'status-green' },
  error: { text: '✗ ошибка', cls: 'status-red' },
};

// Сводка для руководства: тариф, скорость, доля принятых правок
function StatsLine() {
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    fetch('/api/stats').then((r) => r.json()).then((d) => d.ordersTotal !== undefined && setS(d)).catch(() => {});
  }, []);
  if (!s) return null;
  return (
    <div className="stats-line mono">
      за всё время: заказов {s.ordersTotal} (готово {s.ordersDone}) · {s.charsTotal.toLocaleString('ru')} зн ·
      тариф €{s.tariffTotalEur.toFixed(2)} · ср. проверка {s.avgCheckSeconds} с ·
      правок {s.editsFound}, принято {s.editsAccepted} ({Math.round(s.acceptRate * 100)}%)
    </div>
  );
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [filter, setFilter] = useState<string>('all'); // фильтр по статусу
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [profileFilter, setProfileFilter] = useState<number | 'all'>('all'); // фильтр списка по профилю
  const [uploadProfileId, setUploadProfileId] = useState<number | null>(null); // профиль для новых заказов (запоминается)
  const { me, users } = useMe();
  const canUpload = me && me.role !== 'designer';
  const isStaff = me && (me.role === 'admin' || me.role === 'manager');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/orders');
    const data = await res.json().catch(() => null);
    // 401/403 отдают {error} — не массив; защищаемся, чтобы не уронить рендер
    setOrders(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000); // простое обновление статусов
    return () => clearInterval(t);
  }, [load]);

  // профили + последний использованный (localStorage)
  useEffect(() => {
    fetch('/api/profiles').then((r) => r.json()).then((ps: ProfileOption[]) => {
      if (!Array.isArray(ps)) return;
      setProfiles(ps);
      const saved = Number(localStorage.getItem('pp-upload-profile'));
      setUploadProfileId(ps.some((p) => p.id === saved) ? saved : ps[0]?.id ?? null);
    }).catch(() => {});
  }, []);

  function chooseProfile(id: number) {
    setUploadProfileId(id);
    localStorage.setItem('pp-upload-profile', String(id)); // запоминаем выбор
  }

  async function upload(file: File) {
    setUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    if (uploadProfileId != null) fd.append('profileId', String(uploadProfileId));
    const res = await fetch('/api/orders', { method: 'POST', body: fd });
    const body = await res.json().catch(() => ({}));
    setUploading(false);
    if (!res.ok) {
      alert(`Загрузка отклонена: ${body.error ?? res.status}`); // валидация: тип/размер/пустота
    } else if (body.duplicateOf) {
      alert(`Внимание: такой же текст уже проверялся — заказ #${body.duplicateOf.id} («${body.duplicateOf.filename}»). Новый заказ #${body.id} всё равно создан.`);
    }
    load();
  }

  return (
    <div className="wrap">
      <header className="masthead">
        <Link className="brand" href="/">PrintProof</Link>
        <span>Заказы</span>
        {isStaff && <Link href="/profiles">Профили клиентов</Link>}
        <span className="ctx" style={{ marginLeft: 'auto' }}><UserBar me={me} users={users} /></span>
      </header>
      <hr className="rule-double" />
      <hr className="rule-thin" />

      {isStaff && (
      <div className="upload-profile">
        <span className="label">профиль для новых заказов</span>
        <select
          className="pe-input" style={{ width: 'auto' }}
          value={uploadProfileId ?? ''}
          onChange={(e) => chooseProfile(Number(e.target.value))}
        >
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      )}

      {canUpload && (
      <div
        className={`dropzone ${dragOver ? 'over' : ''}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files[0];
          if (f) upload(f);
        }}
      >
        {uploading ? (
          <div>Загрузка и оценка…</div>
        ) : (
          <>
            <div>Перетащите файл заказа — DOCX, TXT, MD, PDF, PNG или JPEG</div>
            <div className="hint">оценка объёма, срока и цены появится сразу после загрузки</div>
            <div style={{ marginTop: '0.6rem' }}><span className="action">Выбрать файл…</span></div>
          </>
        )}
        <input
          ref={fileRef} type="file" hidden
          accept=".docx,.txt,.md,.pdf,.png,.jpg,.jpeg"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
      </div>
      )}

      <div className="filters">
        {([
          ['all', 'Все', (o: OrderRow) => true],
          ['review', 'На приёмке', (o: OrderRow) => o.status === 'review'],
          ['working', 'В работе', (o: OrderRow) => ['uploaded', 'estimated', 'queued', 'checking'].includes(o.status)],
          ['done', 'Готовые', (o: OrderRow) => o.status === 'done'],
          ['error', 'Ошибки', (o: OrderRow) => o.status === 'error'],
        ] as [string, string, (o: OrderRow) => boolean][]).map(([key, label, pred]) => {
          const count = orders.filter(pred).length;
          if (key === 'error' && count === 0) return null;
          return (
            <button
              key={key}
              className={`filter-chip ${filter === key ? 'active' : ''}`}
              onClick={() => setFilter(key)}
            >
              {label} <span className="mono">{count}</span>
            </button>
          );
        })}
        <select
          className="pe-input" style={{ width: 'auto', marginLeft: 'auto' }}
          value={profileFilter}
          onChange={(e) => setProfileFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
        >
          <option value="all">все профили</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <table>
        <thead>
          <tr>
            <th>Заказ</th>
            <th>Профиль</th>
            <th>Тип</th>
            <th>Оценка: объём · цена</th>
            <th>Статус</th>
            <th>Действие</th>
          </tr>
        </thead>
        <tbody>
          {orders.filter((o) => {
            if (profileFilter !== 'all' && o.clientProfileId !== profileFilter) return false;
            if (filter === 'review') return o.status === 'review';
            if (filter === 'working') return ['uploaded', 'estimated', 'queued', 'checking'].includes(o.status);
            if (filter === 'done') return o.status === 'done';
            if (filter === 'error') return o.status === 'error';
            return true;
          }).map((o) => {
            const s = STATUS_LABEL[o.status] ?? { text: o.status, cls: '' };
            const statusText = o.progress ? `${s.text} ${o.progress.done}/${o.progress.total}` : s.text;
            return (
              <tr key={o.id}>
                <td>
                  #{o.id} · {o.filename}
                  <div className="footnote">{o.createdAt}{o.error ? ` — ${o.error}` : ''}</div>
                </td>
                <td style={{ fontSize: '0.9rem' }}>{profiles.find((p) => p.id === o.clientProfileId)?.name ?? '—'}</td>
                <td>{o.type === 'text' ? 'текст' : o.type === 'pdf' ? 'pdf' : 'макет'}</td>
                <td className="mono" style={{ fontSize: '0.85rem' }}>
                  {o.estimate ? (
                    <span className="tip">
                      <span style={{ cursor: 'help', borderBottom: '1px dotted var(--rule)' }}>
                        {o.estimate.chars.toLocaleString('ru')} зн · €{o.estimate.priceEur.toFixed(2)}
                      </span>
                      <span className="tipbox">
                        {o.estimate.breakdown ? (
                          <>
                            <div>КАК ПОСЧИТАНА ЦЕНА</div>
                            <div className="dim">тариф клиенту: {o.estimate.breakdown.formula}</div>
                            <div className="dim" style={{ marginTop: '4px' }}>
                              себестоимость AI: {o.estimate.breakdown.model} ·{' '}
                              ~{o.estimate.breakdown.inputTokens.toLocaleString('ru')} ток. вход + ~{o.estimate.breakdown.outputTokens.toLocaleString('ru')} ток. выход
                            </div>
                            <div className="dim">
                              (${o.estimate.breakdown.modelPriceInUsdPerMTok}/${o.estimate.breakdown.modelPriceOutUsdPerMTok} за MTok) ≈ €{o.estimate.breakdown.tokenCostEur.toFixed(4)}
                            </div>
                            <div className="dim" style={{ marginTop: '4px' }}>rule-pass и resolver — код, 0 токенов</div>
                          </>
                        ) : (
                          <div className="dim">разбивка недоступна для старых заказов</div>
                        )}
                      </span>
                    </span>
                  ) : '—'}
                </td>
                <td>
                  <span className={`mono ${s.cls}`} style={{ fontSize: '0.85rem' }}>{statusText}</span>
                  {(() => {
                    // SLA: укладываемся ли в обещанную оценку времени
                    const sla = slaStatus({ status: o.status, createdAt: o.createdAt, etaMinutes: o.estimate?.etaMinutes }, new Date());
                    return sla.state === 'overdue' ? (
                      <span className="mono status-red" style={{ fontSize: '0.75rem' }} title="дольше оценки"> ⚠ +{sla.overdueMinutes} мин</span>
                    ) : null;
                  })()}
                </td>
                <td>
                  {(o.status === 'review' || o.status === 'done') && (
                    <Link className="act" href={`/orders/${o.id}`}>
                      {o.status === 'review' ? 'Открыть приёмку →' : 'Открыть / экспорт →'}
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
          {orders.length === 0 && (
            <tr><td colSpan={6} className="footnote">заказов пока нет — загрузите первый файл</td></tr>
          )}
        </tbody>
      </table>

      {isStaff && <StatsLine />}

      <p className="footnote" style={{ marginTop: '1.5rem' }}>
        Каждый заказ хранит протокол приёмки: кто принял, какие правки, когда. Ничего не уходит в печать без решения менеджера.
      </p>
    </div>
  );
}
