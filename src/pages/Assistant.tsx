import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Chip, Empty, Icon, Modal, Page } from '../ui/components';
import { useApp } from '../store';
import {
  CHAT_SUGGESTIONS,
  answer,
  clearChat,
  isAiReady,
  loadChat,
  normalizeBaseUrl,
  saveChat,
  type StoredMessage,
} from '../lib/ai';
import { fmtDateTime } from '../lib/format';

export default function Assistant() {
  const navigate = useNavigate();
  const settings = useApp((s) => s.settings);
  const notify = useApp((s) => s.notify);

  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [error, setError] = useState('');
  const [openMessage, setOpenMessage] = useState<StoredMessage | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const ready = isAiReady();
  const modelLabel = useMemo(() => {
    const cfg = normalizeBaseUrl(settings.ai_base_url);
    if (!cfg || !settings.ai_api_key.trim()) return 'без ключа';
    return settings.ai_model.trim() || 'модель не выбрана';
  }, [settings.ai_base_url, settings.ai_api_key, settings.ai_model]);

  useEffect(() => {
    void loadChat().then(setMessages);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming]);

  async function send(text?: string) {
    const question = (text ?? prompt).trim();
    if (!question || busy) return;
    setPrompt('');
    setError('');
    setStreaming('');

    const history = messages;
    const withQuestion: StoredMessage[] = [
      ...history,
      { role: 'user', text: question, at: new Date().toISOString() },
    ];
    setMessages(withQuestion);
    setBusy(true);

    try {
      const res = await answer(question, history, (_delta, full) => setStreaming(full));
      const next: StoredMessage[] = [
        ...withQuestion,
        { role: 'assistant', text: res.text, at: new Date().toISOString(), offline: res.offline },
      ];
      setMessages(next);
      await saveChat(next);
    } catch (e) {
      const text2 = e instanceof Error ? e.message : 'Не удалось получить ответ';
      setError(text2);
      const next: StoredMessage[] = [
        ...withQuestion,
        { role: 'assistant', text: `Не получилось: ${text2}`, at: new Date().toISOString() },
      ];
      setMessages(next);
      await saveChat(next);
    } finally {
      setBusy(false);
      setStreaming('');
    }
  }

  async function copy(text: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        notify('Ответ скопирован', 'ok');
        return;
      }
    } catch {
      /* ниже запасной способ */
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      notify('Ответ скопирован', 'ok');
    } catch {
      notify('Не удалось скопировать', 'err');
    }
  }

  return (
    <Page title="ИИ-помощник" onBack={() => navigate('/more')}>
      <Card
        title="Помощник"
        actions={
          <Badge tone={ready ? 'ok' : 'neutral'}>
            <Icon name="ai" size={14} /> {modelLabel}
          </Badge>
        }
      >
        <div className="small muted">
          {ready
            ? 'Помощник видит сводку по вашим листам, перевозкам, топливу и деньгам и отвечает на вопросы по ним.'
            : 'Ключ пока не задан, поэтому отвечаю на простые вопросы прямо на телефоне, без обращения к сервису.'}
        </div>

        {!ready ? (
          <div className="alert alert-warn">
            <Icon name="warning" />
            <span>
              Чтобы задавать любые вопросы, укажите адрес API, ключ и модель в настройках ИИ. Ключ хранится только
              на устройстве.
            </span>
          </div>
        ) : null}

        {error ? (
          <div className="alert alert-err">
            <Icon name="warning" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="chip-row">
          {CHAT_SUGGESTIONS.map((s) => (
            <Chip key={s} onClick={() => void send(s)}>
              {s}
            </Chip>
          ))}
        </div>

        <div className="chat-input">
          <textarea
            className="input"
            rows={2}
            placeholder="Спросите что угодно про свои листы, расход или деньги"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button variant="primary" icon="send" disabled={busy || prompt.trim() === ''} onClick={() => void send()}>
            {busy ? 'Думаю…' : 'Спросить'}
          </Button>
        </div>

        <div className="row">
          <Button icon="settings" onClick={() => navigate('/settings')}>
            Настройки ИИ
          </Button>
          <span style={{ flex: 1 }} />
          {messages.length > 0 ? (
            <Button icon="trash" onClick={() => setClearOpen(true)}>
              Очистить
            </Button>
          ) : null}
        </div>
      </Card>

      {messages.length === 0 && !busy ? (
        <Card>
          <Empty text="Пока пусто. Выберите подсказку выше или задайте свой вопрос." />
        </Card>
      ) : (
        <div className="chat">
          {messages.map((m, i) => (
            <div key={`${m.at}-${i}`} className={`bubble ${m.role === 'user' ? 'bubble-user' : 'bubble-ai'}`}>
              <div className="bubble-text">{m.text}</div>
              <div className="bubble-meta">
                <Icon name="clock" size={12} />
                <span>{fmtDateTime(m.at)}</span>
                {m.offline ? <span>· ответ на устройстве</span> : null}
                {m.role === 'assistant' ? (
                  <>
                    <span style={{ flex: 1 }} />
                    <button type="button" className="bubble-action" onClick={() => void copy(m.text)}>
                      <Icon name="copy" size={13} />
                    </button>
                    <button type="button" className="bubble-action" onClick={() => setOpenMessage(m)}>
                      <Icon name="doc" size={13} />
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ))}

          {busy ? (
            <div className="bubble bubble-ai">
              <div className="bubble-text">
                {streaming ? streaming : <span className="muted">Готовлю ответ…</span>}
              </div>
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      )}

      <Card title="Дополнительно">
        <Button icon="doc" onClick={() => navigate('/data')}>
          Отчёты и выгрузки
        </Button>
        <Button icon="route" onClick={() => navigate('/trips')}>
          Перевозки
        </Button>
      </Card>

      <Modal open={openMessage !== null} title="Ответ целиком" onClose={() => setOpenMessage(null)}>
        <div style={{ whiteSpace: 'pre-wrap' }}>{openMessage?.text}</div>
      </Modal>

      <Modal open={clearOpen} title="Очистить переписку" onClose={() => setClearOpen(false)}
        footer={
          <>
            <Button onClick={() => setClearOpen(false)}>Отмена</Button>
            <span style={{ flex: 1 }} />
            <Button
              variant="danger"
              icon="trash"
              onClick={() => {
                void clearChat().then(() => {
                  setMessages([]);
                  setClearOpen(false);
                  notify('Переписка очищена', 'info');
                });
              }}
            >
              Очистить
            </Button>
          </>
        }
      >
        <div className="muted">
          Все сообщения будут удалены с этого устройства. На данные приложения это не влияет.
        </div>
      </Modal>
    </Page>
  );
}
