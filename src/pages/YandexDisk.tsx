import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Confirm,
  Field,
  Icon,
  KV,
  NumberInput,
  Page,
  TextInput,
} from '../ui/components';
import { useApp } from '../store';
import { getDb } from '../db';
import { fmtDateTime, plural } from '../lib/format';
import {
  checkDisk,
  cloudState,
  hasMissingPictures,
  localPictureStats,
  noteError,
  pushIconsOnly,
  pushToDisk,
  pullFromDisk,
  restoreIconsFromDisk,
} from '../lib/yadisk';
import { autoSyncNow } from '../lib/yadisk-auto';

/** Экран обмена с Яндекс Диском: данные — отдельно, значки — отдельно */
export default function YandexDiskPage() {
  const navigate = useNavigate();
  const settings = useApp((s) => s.settings);
  const saveSetting = useApp((s) => s.saveSetting);
  const notify = useApp((s) => s.notify);
  const revision = useApp((s) => s.revision);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [replace, setReplace] = useState(false);
  const [confirmPull, setConfirmPull] = useState(false);

  const state = cloudState();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => localPictureStats(), [revision]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const missing = useMemo(() => hasMissingPictures(), [revision]);

  /** Смена логина или папки — прежние отметки об обмене больше не годятся */
  function saveAccount(key: 'yadisk_login' | 'yadisk_password' | 'yadisk_folder', value: string) {
    saveSetting(key, value);
    if (key !== 'yadisk_password') {
      saveSetting('yadisk_last_data', '');
      saveSetting('yadisk_last_icons', '');
    }
  }

  async function run(name: string, fn: () => Promise<string | void>, ok = 'Готово') {
    setBusy(name);
    setMessage('');
    try {
      const text = await fn();
      await getDb().then((db) => db.flush());
      if (typeof text === 'string' && text) setMessage(text);
      noteError('');
      notify(ok, 'ok');
    } catch (e) {
      const text = e instanceof Error ? e.message : 'Ошибка обмена с Яндекс Диском';
      noteError(text);
      setMessage(text);
      notify('Обмен не удался', 'err');
    } finally {
      setBusy('');
    }
  }

  const iconsSummary = `${stats.pictures} ${plural(stats.pictures, 'картинка', 'картинки', 'картинок')}`
    + `, ${stats.documents} ${plural(stats.documents, 'файл', 'файла', 'файлов')} документов`;

  return (
    <Page title="Яндекс Диск" onBack={() => navigate('/settings')}>
      <Card title="Что происходит" actions={<Icon name="refresh" />}>
        <div className="small muted">
          Данные и значки хранятся в облаке отдельно. <b>Данные</b> — это справочники, путевые листы,
          поездки, заправки, финансы и настройки: они лежат в лёгком файле и уходят быстро.
          <b> Значки</b> — логотипы фирм, машин, грузов, АЗС и фотографии документов: они лежат в отдельном
          архиве и подтягиваются к записям по названию.
        </div>
        <div className="grid-2">
          <KV label="Обмен" value={state.configured ? 'настроен' : 'не настроен'} hint={state.folder} />
          <KV label="Автоматически" value={state.auto ? 'включён' : 'выключен'} />
          <KV
            label="Последний обмен"
            value={state.lastAt ? fmtDateTime(state.lastAt) : 'ещё не было'}
          />
          <KV
            label="Изменения"
            value={state.dirty ? 'есть невыгруженные' : 'всё выгружено'}
            hint={state.lastData ? `последний файл: ${state.lastData}` : undefined}
          />
          <KV label="Значки и документы" value={iconsSummary} />
          <KV label="Архив значков" value={state.lastIcons || 'ещё не выгружался'} />
        </div>
        {state.lastError ? (
          <div className="alert alert-warn">
            <Icon name="warning" />
            <span>В прошлый раз не получилось: {state.lastError}</span>
          </div>
        ) : null}
        {missing ? (
          <div className="small muted">
            У части записей значок ещё не подобран — кнопка «Подтянуть значки» заполнит пустые поля
            из архива в облаке.
          </div>
        ) : null}
        {message ? <div className="alert alert-info"><Icon name="check" /><span>{message}</span></div> : null}
      </Card>

      <Card title="Подключение" actions={<Icon name="settings" />}>
        <details className="guide">
          <summary>
            <Icon name="doc" size={16} />
            <span>Как получить пароль приложения — подробная инструкция</span>
          </summary>
          <ol className="guide-steps">
            <li>
              Откройте страницу паролей приложений:{' '}
              <a
                className="link"
                href="https://id.yandex.ru/security/app-passwords"
                target="_blank"
                rel="noreferrer"
              >
                id.yandex.ru → Безопасность → Пароли приложений
              </a>
              .
            </li>
            <li>
              Нажмите <b>Создать пароль</b> и выберите тип <b>«Файлы»</b> (в некоторых версиях он
              называется «WebDAV-клиент для Яндекс Диска»). Имя любое, например «АвтоБаза».
            </li>
            <li>
              Скопируйте показанный пароль: он виден один раз. Это <b>не</b> обычный пароль от Яндекс ID —
              обычный тут не подойдёт.
            </li>
            <li>
              Логин — имя пользователя Яндекс (например, <b>ivan</b> или <b>ivan@yandex.ru</b>). Пароль
              вставьте в поле «Пароль приложения» ниже и нажмите <b>Проверить подключение</b>.
            </li>
            <li>
              Папка на Диске заведётся сама. По умолчанию это <b>/avtobaza</b> — менять не обязательно.
            </li>
          </ol>
          <div className="small muted">
            Обмен идёт по протоколу WebDAV прямо с телефона, регистрировать приложение и получать ключи не
            нужно. В браузере на компьютере Яндекс Диск чужие страницы не пускает, поэтому обмен работает
            в приложении на телефоне. Логин и пароль хранятся только на устройстве. По WebDAV Яндекс
            открывает Диск подписчикам Яндекс 360.
          </div>
        </details>

        <Field label="Логин Яндекс">
          <TextInput
            value={settings.yadisk_login}
            onChange={(e) => saveAccount('yadisk_login', e.target.value)}
            placeholder="ivan@yandex.ru"
          />
        </Field>
        <Field label="Пароль приложения" hint="не обычный пароль от Яндекс ID">
          <TextInput
            type="password"
            value={settings.yadisk_password}
            onChange={(e) => saveAccount('yadisk_password', e.target.value)}
          />
        </Field>
        <Field label="Папка на Диске">
          <TextInput
            value={settings.yadisk_folder}
            onChange={(e) => saveAccount('yadisk_folder', e.target.value)}
            placeholder="/avtobaza"
          />
        </Field>
        <Field label="Сколько копий держать в облаке">
          <NumberInput
            value={Number(settings.yadisk_keep) || 5}
            onValue={(v) => saveSetting('yadisk_keep', v ?? 5)}
          />
        </Field>
        <Button
          icon="check"
          block
          disabled={busy !== ''}
          onClick={() => void run('check', () => checkDisk(settings.yadisk_login, settings.yadisk_password, settings.yadisk_folder))}
        >
          {busy === 'check' ? 'Проверяю…' : 'Проверить подключение'}
        </Button>
      </Card>

      <Card title="Обмен" actions={<Icon name="upload" />}>
        <label className="row">
          <input
            type="checkbox"
            checked={state.auto}
            onChange={(e) => saveSetting('yadisk_auto', e.target.checked ? 1 : 0)}
          />
          <span>
            Обмениваться автоматически: после изменений — выгрузка, при запуске — свежая копия из облака
          </span>
        </label>
        <Button
          variant="primary"
          icon="refresh"
          block
          disabled={busy !== '' || !state.configured}
          onClick={() => void run('sync', autoSyncNow, 'Обмен выполнен')}
        >
          {busy === 'sync' ? 'Обмениваюсь…' : 'Обменять сейчас'}
        </Button>
        <div className="divider" />
        <div className="small muted">
          Данные ({state.dirty ? 'есть изменения' : 'выгружено всё'})
        </div>
        <Button
          icon="upload"
          block
          disabled={busy !== '' || !state.configured}
          onClick={() =>
            void run('push', async () => {
              const res = await pushToDisk();
              return res.iconsFailed
                ? `Данные выгружены: ${res.dataName}. Архив значков не ушёл — попробуйте ещё раз.`
                : `Выгружено: ${res.dataName}${res.iconsName ? ` и архив значков ${res.iconsName}` : ''}`;
            }, 'Выгружено')
          }
        >
          {busy === 'push' ? 'Выгружаю…' : 'Выгрузить данные'}
        </Button>
        <Button
          icon="download"
          block
          disabled={busy !== '' || !state.configured}
          onClick={() => setConfirmPull(true)}
        >
          {busy === 'pull' ? 'Загружаю…' : 'Загрузить данные из облака'}
        </Button>
        <label className="row">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          <span>
            Загружать заменой: на устройстве останется ровно то, что в облаке (иначе записи только
            дополняются и обновляются)
          </span>
        </label>
        <div className="divider" />
        <div className="small muted">Значки и документы</div>
        <Button
          icon="upload"
          block
          disabled={busy !== '' || !state.configured}
          onClick={() =>
            void run('icons-up', async () => {
              const name = await pushIconsOnly();
              return name
                ? `Архив значков выгружен: ${name}`
                : 'Значков и документов нет — выгружать нечего';
            }, 'Значки выгружены')
          }
        >
          {busy === 'icons-up' ? 'Выгружаю…' : 'Выгрузить значки'}
        </Button>
        <Button
          icon="download"
          block
          disabled={busy !== '' || !state.configured}
          onClick={() =>
            void run('icons-down', async () => {
              const res = await restoreIconsFromDisk();
              if (res.pictures === 0 && res.documents === 0) {
                return res.missing > 0
                  ? `Новых картинок нет: ${res.missing} записей из архива не нашлось на устройстве`
                  : 'Все значки и документы уже на месте';
              }
              return `Подтянуто: картинок ${res.pictures}, документов ${res.documents}`
                + (res.missing > 0 ? `. Не нашлось записей: ${res.missing}` : '');
            }, 'Значки подтянуты')
          }
        >
          {busy === 'icons-down' ? 'Подтягиваю…' : 'Подтянуть значки из облака'}
        </Button>
        <div className="small muted">
          Подтягивание заполняет только пустые поля: уже подобранные значки не затираются. Фотографии
          документов скачиваются, если их нет на устройстве.
        </div>
      </Card>

      <Confirm
        open={confirmPull}
        title="Загрузить данные из облака?"
        text={
          replace
            ? 'Все записи на устройстве будут заменены тем, что лежит в облаке. Значки и фотографии документов останутся на месте.'
            : 'Записи из облака дополнят и обновят то, что есть на устройстве. Свои записи, которых нет в облаке, останутся.'
        }
        confirmLabel="Загрузить"
        onCancel={() => setConfirmPull(false)}
        onConfirm={() => {
          setConfirmPull(false);
          void run('pull', async () => {
            const res = await pullFromDisk(replace);
            return `Загружено: ${res.dataName}. Записей добавлено ${res.inserted}, обновлено ${res.updated}`
              + (res.icons.pictures > 0 || res.icons.documents > 0
                ? `, картинок подтянуто ${res.icons.pictures}`
                : '');
          }, 'Загружено');
        }}
      />
    </Page>
  );
}
