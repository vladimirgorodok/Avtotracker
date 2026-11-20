import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Empty, Icon, Modal, Tabs } from '../ui/components';
import { useApp } from '../store';
import { fmtDateTime } from '../lib/format';
import { SaveBadge } from '../ui/SaveBadge';
import {
  LEVEL_LABELS,
  KIND_LABELS,
  applyFinding,
  audit,
  auditCounts,
  auditGroups,
  lastAppliedFix,
  loadHidden,
  saveHidden,
  undoLastFix,
  type AppliedFix,
  type Finding,
  type FindingLevel,
} from '../lib/audit';

type LevelTab = 'all' | FindingLevel;

const LEVEL_TONE: Record<FindingLevel, 'err' | 'warn' | 'info'> = {
  err: 'err',
  warn: 'warn',
  info: 'info',
};

/** Пояснения идут строчками: «- » превращаем в точку списка, переносы сохраняем */
function linesText(lines: string[]): string {
  return lines.map((l) => (l.startsWith('- ') ? '• ' + l.slice(2) : l)).join('\n');
}

/**
 * Проверка данных: что нашлось в базе и что с этим можно сделать.
 *
 * Экран ничего не решает сам: по каждой находке видно, почему так решили и к
 * каким записям это относится, а действие выполняется только после подтверждения.
 */
export default function Audit() {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);

  const [hidden, setHidden] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [level, setLevel] = useState<LevelTab>('all');
  const [confirm, setConfirm] = useState<Finding | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<AppliedFix | null>(() => lastAppliedFix());

  useEffect(() => {
    void loadHidden().then(setHidden);
  }, []);

  // Список находок считается заново после каждой правки и внешних изменений
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const findings = useMemo(() => audit(), [revision]);
  const counts = useMemo(() => auditCounts(findings), [findings]);

  const visible = findings.filter((f) => !hidden.includes(f.id));
  const shown = level === 'all' ? visible : visible.filter((f) => f.level === level);
  const groups = auditGroups(shown);
  const hiddenItems = findings.filter((f) => hidden.includes(f.id));

  async function hide(f: Finding) {
    const next = [...hidden, f.id];
    setHidden(next);
    await saveHidden(next);
  }

  async function unhide(id: string) {
    const next = hidden.filter((x) => x !== id);
    setHidden(next);
    await saveHidden(next);
  }

  async function runFix() {
    if (!confirm || !confirm.fix) return;
    setBusy(true);
    try {
      const entry = await applyFinding(confirm);
      setApplied(entry);
      setConfirm(null);
      touch();
      notify('Правка выполнена. Вернуть можно кнопкой «Вернуть»', 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось выполнить правку', 'err');
    } finally {
      setBusy(false);
    }
  }

  function undo() {
    if (!applied) return;
    if (!undoLastFix()) {
      notify('Эту правку вернуть нельзя: файлы удалены с устройства', 'err');
      return;
    }
    setApplied(null);
    touch();
    notify('Всё вернулось как было', 'info');
  }

  return (
    <div className="page">
      <header className="topbar">
        <button className="icon-btn" onClick={() => navigate('/more')} aria-label="Назад">
          <Icon name="back" />
        </button>
        <h1>Проверка данных</h1>
        <SaveBadge />
        <div className="topbar-actions" />
      </header>

      <div className="page-body">
        <Card>
          <div className="small muted">
            Проверка просматривает все записи и собирает то, что похоже на ошибку: дубли в деньгах,
            двойные начисления, одинаковые названия в справочниках, ссылки в никуда, пустые записи,
            замечания по листам и лишние файлы. Ничего не меняется без вашего подтверждения, а после
            правки есть кнопка «Вернуть».
          </div>
        </Card>

        {applied ? (
          <Card
            title="Последняя правка"
            actions={
              <Badge tone={applied.permanent ? 'warn' : 'ok'}>
                <Icon name="check" size={14} /> выполнена
              </Badge>
            }
          >
            <div className="small">
              {applied.label} · {applied.title}
            </div>
            <div className="small muted">{fmtDateTime(applied.at)}</div>
            {applied.permanent ? (
              <div className="alert alert-warn">
                <Icon name="warning" />
                <span>Вернуть эту правку нельзя: файлы удалены с устройства окончательно.</span>
              </div>
            ) : (
              <Button variant="soft" icon="undo" block onClick={undo}>
                Вернуть
              </Button>
            )}
          </Card>
        ) : null}

        <Card>
          <div className="row">
            <Badge tone="err">{counts.err}</Badge>
            <span className="small muted">ошибки</span>
            <Badge tone="warn">{counts.warn}</Badge>
            <span className="small muted">внимание</span>
            <Badge tone="info">{counts.info}</Badge>
            <span className="small muted">к сведению</span>
          </div>
        </Card>

        <Tabs<LevelTab>
          value={level}
          onChange={setLevel}
          items={[
            { value: 'all', label: `Все (${visible.length})` },
            { value: 'err', label: `Ошибки (${counts.err})` },
            { value: 'warn', label: `Внимание (${counts.warn})` },
            { value: 'info', label: `К сведению (${counts.info})` },
          ]}
        />

        {shown.length === 0 ? (
          <Card>
            <Empty
              text={
                findings.length === 0
                  ? 'Проверка ничего подозрительного не нашла.'
                  : level === 'all'
                    ? 'Все находки скрыты. Их можно вернуть ниже.'
                    : 'В этой группе находок нет.'
              }
            />
          </Card>
        ) : (
          groups.map((group) => (
            <Card
              key={group.kind}
              title={KIND_LABELS[group.kind]}
              actions={<Badge tone="neutral">{group.items.length}</Badge>}
            >
              {group.items.map((f) => (
                <div key={f.id} className="audit-finding">
                  <div className="row">
                    <Badge tone={LEVEL_TONE[f.level]}>{LEVEL_LABELS[f.level]}</Badge>
                    <b className="audit-title">{f.title}</b>
                  </div>

                  <div className="small muted audit-lines">{linesText(f.details)}</div>

                  {f.advice ? (
                    <div className="alert alert-warn">
                      <Icon name="warning" />
                      <span>{f.advice}</span>
                    </div>
                  ) : null}

                  {f.fix ? (
                    <Button variant="primary" icon="check" block onClick={() => setConfirm(f)}>
                      {f.fix.label}
                    </Button>
                  ) : null}

                  <div className="row">
                    {f.openTo ? (
                      <Button icon="eye" onClick={() => navigate(f.openTo!)}>
                        Открыть
                      </Button>
                    ) : null}
                    <span style={{ flex: 1 }} />
                    <Button icon="close" onClick={() => void hide(f)}>
                      Скрыть
                    </Button>
                  </div>
                </div>
              ))}
            </Card>
          ))
        )}

        {hiddenItems.length > 0 ? (
          <Card
            title="Скрытые находки"
            actions={
              <Button
                variant="soft"
                icon={showHidden ? 'up' : 'down'}
                onClick={() => setShowHidden(!showHidden)}
              >
                {showHidden ? 'Свернуть' : `Показать (${hiddenItems.length})`}
              </Button>
            }
          >
            <div className="small muted">
              Скрытые находки не мешают: проверка их больше не показывает, пока вы не вернёте их сами.
            </div>
            {showHidden
              ? hiddenItems.map((f) => (
                  <div key={f.id} className="audit-finding">
                    <div className="small">{f.title}</div>
                    <Button icon="undo" onClick={() => void unhide(f.id)}>
                      Вернуть в список
                    </Button>
                  </div>
                ))
              : null}
            <Button
              icon="refresh"
              onClick={() => {
                setHidden([]);
                void saveHidden([]);
                notify('Скрытые находки возвращены в список', 'info');
              }}
            >
              Показать все находки
            </Button>
          </Card>
        ) : null}
      </div>

      <Modal
        open={confirm !== null}
        title={confirm?.fix?.label ?? 'Подтверждение'}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Отмена</Button>
            <span style={{ flex: 1 }} />
            <Button variant="danger" icon="check" disabled={busy} onClick={() => void runFix()}>
              {busy ? 'Выполняю…' : 'Подтвердить'}
            </Button>
          </>
        }
      >
        {confirm?.fix ? (
          <>
            <p>{confirm.fix.what}</p>
            {confirm.fix.links.length > 0 ? (
              <div className="small muted audit-lines">
                Что затронет:{'\n' + linesText(confirm.fix.links)}
              </div>
            ) : null}
            {confirm.fix.permanent ? (
              <div className="alert alert-warn">
                <Icon name="warning" />
                <span>Отменить это действие будет нельзя.</span>
              </div>
            ) : null}
          </>
        ) : null}
      </Modal>
    </div>
  );
}

