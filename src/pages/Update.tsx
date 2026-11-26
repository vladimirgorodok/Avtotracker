import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Icon, KV, Page } from '../ui/components';
import { useApp } from '../store';
import {
  APP_VERSION,
  canInstall,
  checkForUpdate,
  downloadUpdate,
  fileSize,
  installUpdate,
  installedVersion,
  isNewer,
  nativeUpdateReady,
  openInstallSettings,
  releasePageUrl,
  type ReleaseInfo,
} from '../lib/update';
import { fmtDateTime } from '../lib/format';

type Busy = '' | 'check' | 'download' | 'install';

/** Экран «Обновление»: проверка сборки на GitHub, скачивание и установка */
export default function UpdatePage() {
  const navigate = useNavigate();
  const notify = useApp((s) => s.notify);
  const revision = useApp((s) => s.revision);
  const settings = useApp((s) => s.settings);
  const saveSetting = useApp((s) => s.saveSetting);
  const touch = useApp((s) => s.touch);

  const [busy, setBusy] = useState<Busy>('');
  const [message, setMessage] = useState('');
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [current, setCurrent] = useState(APP_VERSION);
  const [checked, setChecked] = useState(false);
  const [percent, setPercent] = useState(0);
  const [downloaded, setDownloaded] = useState(false);
  const [installAllowed, setInstallAllowed] = useState(true);

  const native = nativeUpdateReady();
  const newer = info ? isNewer(info, current) : false;

  // Разрешение на установку мог поменять сам человек — перечитываем при возврате
  useEffect(() => {
    if (!native) return;
    let alive = true;
    void canInstall()
      .then((ok) => {
        if (alive) setInstallAllowed(ok);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [native, revision, busy]);

  // Точную версию установленной сборки знает система — спрашиваем у неё
  useEffect(() => {
    let alive = true;
    void installedVersion().then((v) => {
      if (alive) setCurrent(v.version);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function runCheck() {
    setBusy('check');
    setMessage('');
    setChecked(false);
    try {
      const state = await checkForUpdate();
      setInfo(state.info);
      setCurrent(state.current);
      setChecked(true);
      setDownloaded(false);
      setPercent(0);
      if (!state.available) notify('У вас последняя версия', 'ok');
    } catch (e) {
      setChecked(true);
      setInfo(null);
      setMessage(e instanceof Error ? e.message : 'Не удалось проверить обновление');
      notify('Проверка не удалась', 'err');
    } finally {
      setBusy('');
    }
  }

  async function runDownload() {
    if (!info) return;
    setBusy('download');
    setMessage('');
    setPercent(0);
    try {
      await downloadUpdate(info, setPercent);
      setDownloaded(true);
      notify('Сборка скачана и проверена — открываю установщик', 'ok');
      setBusy('');
      // Сразу передаём сборку системе: установку всё равно подтверждает человек
      await runInstall();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Не удалось скачать сборку');
      notify('Скачать не удалось', 'err');
      setBusy('');
    }
  }

  async function runInstall() {
    setBusy('install');
    setMessage('');
    try {
      await installUpdate();
      notify('Открываю установщик — подтвердите установку', 'info');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Не удалось открыть установщик');
      notify('Установка не открылась', 'err');
    } finally {
      setBusy('');
    }
  }

  return (
    <Page title="Обновление" onBack={() => navigate('/more')}>
      <Card title="Версия приложения" actions={<Icon name="download" />}>
        <div className="grid-2">
          <KV label="Установлено" value={current || '—'} />
          <KV label="На GitHub" value={info ? info.version : '—'} />
          <KV label="Последняя проверка" value={settings.update_last_at ? fmtDateTime(settings.update_last_at) : 'ещё не проверяли'} />
          {info && info.publishedAt ? <KV label="Сборка выложена" value={fmtDateTime(info.publishedAt)} /> : null}
        </div>

        {!native ? (
          <div className="alert alert-info">
            <Icon name="download" />
            <span>
              Установка доступна в приложении на телефоне. Здесь можно посмотреть, что вышло нового, и
              открыть страницу сборки.
            </span>
          </div>
        ) : null}

        <Button icon="refresh" block disabled={busy !== ''} onClick={() => void runCheck()}>
          {busy === 'check' ? 'Проверяю…' : 'Проверить обновление'}
        </Button>

        {message ? (
          <div className="alert alert-err">
            <Icon name="warning" />
            <span>{message}</span>
          </div>
        ) : null}

        {checked && !message && !newer ? (
          <div className="alert alert-info">
            <Icon name="check" />
            <span>У вас последняя версия — обновлять нечего.</span>
          </div>
        ) : null}
      </Card>

      {newer && info ? (
        <Card title={`Доступна версия ${info.version}`} actions={<Icon name="download" />}>
          <div className="grid-2">
            <KV label="Размер" value={fileSize(info.size) || '—'} />
            {info.commit ? <KV label="Коммит" value={info.commit} /> : null}
            <KV label="Установлено" value={current || '—'} />
            <KV label="Будет установлено" value={info.version} />
          </div>
          <div className="small muted">
            Новая версия ставится поверх текущей: записи, справочники и настройки останутся на месте.
          </div>

          {busy === 'download' || (percent > 0 && !downloaded) ? (
            <div>
              <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                <i style={{ width: `${percent}%` }} />
              </div>
              <div className="small muted">Скачано: {percent}%</div>
            </div>
          ) : null}

          {!native ? (
            <Button
              variant="primary"
              icon="nav"
              block
              onClick={() => window.open(releasePageUrl(), '_blank', 'noopener')}
            >
              Открыть страницу сборки
            </Button>
          ) : !installAllowed ? (
            <>
              <div className="alert alert-warn">
                <Icon name="warning" />
                <span>
                  Android пока не разрешает приложению ставить сборки поверх себя. Откроется системный
                  экран — включите разрешение и вернитесь сюда.
                </span>
              </div>
              <Button
                variant="primary"
                icon="settings"
                block
                onClick={() => void openInstallSettings().catch(() => undefined)}
              >
                Разрешить установку
              </Button>
            </>
          ) : !downloaded ? (
            <Button
              variant="primary"
              icon="download"
              block
              disabled={busy !== ''}
              onClick={() => void runDownload()}
            >
              {busy === 'download' ? 'Скачиваю…' : 'Скачать и установить'}
            </Button>
          ) : (
            <Button variant="primary" icon="check" block disabled={busy !== ''} onClick={() => void runInstall()}>
              {busy === 'install' ? 'Открываю…' : 'Открыть установщик'}
            </Button>
          )}

          {downloaded ? (
            <div className="small muted">
              Сборка скачана и проверена. Если установщик не открылся, нажмите «Открыть установщик» и
              подтвердите установку в системном окне.
            </div>
          ) : (
            <div className="small muted">
              Скачивание идёт прямо в приложении, файл проверяется по контрольной сумме с GitHub. Установку
              подтверждает система — приложение ничего не ставит само.
            </div>
          )}
        </Card>
      ) : null}

      <Card title="Проверка при запуске" actions={<Icon name="clock" />}>
        <label className="row">
          <input
            type="checkbox"
            checked={Number(settings.update_auto) === 1}
            onChange={(e) => {
              saveSetting('update_auto', e.target.checked ? 1 : 0);
              touch();
            }}
          />
          <span>
            Проверять обновления при запуске — не чаще раза в сутки. О новой версии приложение скажет
            весточкой, ставить её будете сами.
          </span>
        </label>
      </Card>
    </Page>
  );
}
