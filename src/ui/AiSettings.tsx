/** Настройки ИИ: адрес, ключ, модель и проверка подключения. */

import { useState } from 'react';
import { Badge, Button, Field, Icon, TextInput } from './components';
import { useApp } from '../store';
import { listModels, normalizeBaseUrl, readAiConfig } from '../lib/ai';

export function AiSettings() {
  const settings = useApp((s) => s.settings);
  const saveSetting = useApp((s) => s.saveSetting);
  const notify = useApp((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);

  const cfg = readAiConfig();
  const configured = cfg !== null;
  const ready = configured && settings.ai_model.trim() !== '';

  async function check() {
    const config = readAiConfig();
    if (!config) {
      notify('Сначала укажите адрес API и ключ', 'err');
      return;
    }
    setBusy(true);
    try {
      const list = await listModels(config);
      setModels(list);
      if (list.length === 0) {
        notify('Сервис не вернул список моделей — укажите название вручную', 'err');
        return;
      }
      if (!list.includes(settings.ai_model.trim())) saveSetting('ai_model', list[0]);
      notify(`Подключение работает, доступно моделей: ${list.length}`, 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось подключиться', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-sm">
      <div className="row wrap">
        <Badge tone={configured ? 'ok' : 'warn'}>{configured ? 'Адрес и ключ указаны' : 'Нужен адрес и ключ'}</Badge>
        <Badge tone={ready ? 'ok' : 'neutral'}>{ready ? 'Готов к работе' : 'Модель не выбрана'}</Badge>
      </div>

      <Field label="Адрес API" hint="Подойдёт любой сервис с OpenAI-совместимым API">
        <TextInput
          value={settings.ai_base_url}
          onChange={(e) => saveSetting('ai_base_url', e.target.value)}
          placeholder="https://api.aitunnel.ru/v1"
        />
      </Field>
      {settings.ai_base_url.trim() !== '' && normalizeBaseUrl(settings.ai_base_url) !== settings.ai_base_url.trim() ? (
        <div className="small muted">Адрес будет использован как {normalizeBaseUrl(settings.ai_base_url)}</div>
      ) : null}

      <Field label="Ключ API" hint="Хранится только на устройстве, в коде приложения его нет">
        <TextInput
          type="password"
          value={settings.ai_api_key}
          onChange={(e) => saveSetting('ai_api_key', e.target.value)}
          placeholder="sk-..."
        />
      </Field>

      <Field label="Модель">
        <TextInput
          value={settings.ai_model}
          onChange={(e) => saveSetting('ai_model', e.target.value)}
          placeholder="например, gpt-4o-mini"
          list="ai-models"
        />
      </Field>
      {models.length > 0 ? (
        <datalist id="ai-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      ) : null}

      <div className="row">
        <Button icon="refresh" disabled={busy} onClick={check}>
          {busy ? 'Проверяю…' : 'Проверить подключение'}
        </Button>
      </div>

      {models.length > 0 ? (
        <div className="small muted">
          <Icon name="check" size={13} /> Доступно моделей: {models.length}. Начните вводить название — появятся
          подсказки.
        </div>
      ) : null}
    </div>
  );
}
