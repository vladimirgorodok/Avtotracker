import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, Field, Icon, Page } from '../ui/components';
import { useApp } from '../store';
import { refs, tripRepo, waybillRepo } from '../db/repo';
import { summarizeTrip, summarizeWaybill } from '../lib/calc';
import { fmtDate, fmtMoney, fmtNumber } from '../lib/format';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
}

/** Короткая сводка по базе, которая отправляется модели как контекст */
function buildContext(): string {
  const settings = useApp.getState().settings;
  const waybills = waybillRepo.list().slice(0, 10);
  const lines: string[] = [];
  lines.push(`Ставки: база ${settings.base_amount}, доплата за точку ${settings.extra_point_amount}, базовых точек ${settings.base_points}.`);
  lines.push(`Всего листов: ${waybillRepo.list().length}, перевозок: ${tripRepo.all().length}.`);
  lines.push('Последние путевые листы:');
  for (const w of waybills) {
    const s = summarizeWaybill(w);
    lines.push(
      `- ${fmtDate(w.date_out)}—${w.date_in ? fmtDate(w.date_in) : 'открыт'}, ${s.vehicleTitle}, пробег ${
        s.mileage === null ? '—' : fmtNumber(s.mileage)
      } км, заправлено ${fmtNumber(s.refueled)} л, расход ${
        s.avgConsumption === null ? '—' : fmtNumber(s.avgConsumption, 1)
      } л/100 км, начислено ${fmtMoney(s.charged)}.`,
    );
  }
  const trips = tripRepo.all().slice(0, 10).map(summarizeTrip);
  if (trips.length > 0) {
    lines.push('Последние перевозки:');
    for (const t of trips) {
      lines.push(`- ${fmtDate(t.dateLoad)} ${t.title}, точек ${t.pointsCount}, вес ${fmtNumber(t.totalWeight)} кг, начислено ${fmtMoney(t.amount)}.`);
    }
  }
  const places = refs.places().slice(0, 20).map((p) => p.name).join(', ');
  if (places) lines.push(`Справочник мест: ${places}.`);
  return lines.join('\n');
}

export default function Assistant() {
  const navigate = useNavigate();
  const settings = useApp((s) => s.settings);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = settings.ai_api_key.trim() !== '' && settings.ai_model.trim() !== '';

  async function send() {
    if (!prompt.trim() || busy) return;
    if (!ready) {
      navigate('/settings');
      return;
    }
    const question = prompt.trim();
    setPrompt('');
    const history: Msg[] = [...messages, { role: 'user', text: question }];
    setMessages(history);
    setBusy(true);
    try {
      const res = await fetch(`${settings.ai_base_url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.ai_api_key}`,
        },
        body: JSON.stringify({
          model: settings.ai_model,
          messages: [
            {
              role: 'system',
              content:
                'Ты помощник водителя грузовика. Отвечай коротко и по делу на русском языке. Ниже данные из приложения «Автотрекер».\n\n' +
                buildContext(),
            },
            ...history.map((m) => ({ role: m.role, content: m.text })),
          ],
          temperature: 0.2,
        }),
      });
      if (!res.ok) throw new Error(`Ошибка сервиса: ${res.status}`);
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const answer = json.choices?.[0]?.message?.content ?? 'Пустой ответ';
      setMessages([...history, { role: 'assistant', text: answer }]);
    } catch (e) {
      setMessages([
        ...history,
        { role: 'assistant', text: e instanceof Error ? e.message : 'Не удалось получить ответ' },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="ИИ-помощник" onBack={() => navigate('/more')}>
      <Card title="Единый ИИ-помощник" actions={<Icon name="ai" />}>
        <div className="small muted">
          Опишите, что нужно сделать. Помощник видит сводку по вашим путевым листам, перевозкам и расходам.
        </div>
        {!ready ? (
          <div className="alert alert-warn">
            <Icon name="warning" />
            <span>Сначала укажите адрес API, ключ и модель в настройках.</span>
          </div>
        ) : null}
        <Field label="Что нужно сделать">
          <textarea
            className="input"
            rows={3}
            placeholder="Например: посчитай расход за прошлый месяц или проверь лист за 11.11"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
        <div className="row">
          <Button variant="primary" icon="ai" disabled={busy} onClick={send}>
            {busy ? 'Думаю…' : 'Спросить'}
          </Button>
          <Button icon="settings" onClick={() => navigate('/settings')}>
            Настройки ИИ
          </Button>
        </div>
      </Card>

      {messages.length === 0 ? (
        <Card>
          <Empty text="Пока пусто. Задайте вопрос по вашим данным." />
        </Card>
      ) : (
        <div className="stack">
          {messages.map((m, i) => (
            <Card key={i} title={m.role === 'user' ? 'Вы' : 'Помощник'}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
            </Card>
          ))}
        </div>
      )}

      <Card title="Дополнительные инструменты">
        <Button icon="doc" onClick={() => navigate('/data')}>
          Отчёты и выгрузки
        </Button>
        <Button icon="upload" onClick={() => navigate('/data')}>
          Импорт данных из файла
        </Button>
      </Card>
    </Page>
  );
}
