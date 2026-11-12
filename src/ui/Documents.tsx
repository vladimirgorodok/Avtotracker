/** Фото документов: накладные, чеки, ТТН — снимок с камеры или файл. */

import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Confirm, Empty, Field, Icon, Modal, TextInput } from './components';
import { useApp } from '../store';
import type { DocumentRow } from '../lib/documents';
import { addPhoto, deleteDocument, documentDataUrl, listDocuments, renameDocument } from '../lib/documents';
import { isPending } from '../lib/sync';
import { fmtDateTime, fmtNumber } from '../lib/format';

export function DocumentsCard({
  ownerTable,
  ownerId,
  title = 'Документы',
}: {
  ownerTable: string;
  ownerId: string;
  title?: string;
}) {
  const revision = useApp((s) => s.revision);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<DocumentRow | null>(null);
  const [confirm, setConfirm] = useState<DocumentRow | null>(null);

  const docs = useMemo(
    () => listDocuments(ownerTable, ownerId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownerTable, ownerId, revision],
  );

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        await addPhoto(ownerTable, ownerId, file, file.name.replace(/\.[^.]+$/, ''));
      }
      touch();
      notify(`Добавлено файлов: ${files.length}`, 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось добавить файл', 'err');
    } finally {
      setBusy(false);
    }
  }

  const totalBytes = docs.reduce((s, d) => s + (d.size ?? 0), 0);

  return (
    <div className="stack-sm">
      <div className="section-title">
        {title} <span className="count">{docs.length}</span>
        {docs.length > 0 ? <span className="small muted">· {fmtNumber(Math.round(totalBytes / 1024))} КБ</span> : null}
        <span style={{ flex: 1 }} />
        <label className={`btn btn-soft ${busy ? 'btn-disabled' : ''}`}>
          <Icon name="plus" />
          <span>{busy ? 'Обработка…' : 'Снимок или файл'}</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {docs.length === 0 ? (
        <div className="hint-box">
          Нажмите «Снимок или файл», чтобы сфотографировать накладную или чек. Снимки хранятся на телефоне и
          уходят в облако при синхронизации.
        </div>
      ) : (
        <div className="thumbs">
          {docs.map((d) => (
            <Thumb key={d.id} doc={d} onOpen={() => setViewer(d)} />
          ))}
        </div>
      )}

      <Modal
        open={viewer !== null}
        title={viewer?.title || 'Документ'}
        onClose={() => setViewer(null)}
        footer={
          <>
            <Button variant="danger" icon="trash" onClick={() => setConfirm(viewer)}>
              Удалить
            </Button>
            <span style={{ flex: 1 }} />
            <Button
              icon="share"
              onClick={() => {
                if (viewer) void openExternally(viewer, notify);
              }}
            >
              Открыть
            </Button>
            <Button variant="primary" icon="check" onClick={() => setViewer(null)}>
              Закрыть
            </Button>
          </>
        }
      >
        {viewer ? <ViewerContent doc={viewer} /> : null}
      </Modal>

      <Confirm
        open={confirm !== null}
        title="Удалить документ"
        text="Файл будет удалён с телефона, а в облаке отметится как удалённый при следующей синхронизации."
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) {
            void deleteDocument(confirm.id).then(() => {
              touch();
              notify('Документ удалён', 'info');
            });
          }
          setConfirm(null);
          setViewer(null);
        }}
      />
    </div>
  );
}

function Thumb({ doc, onOpen }: { doc: DocumentRow; onOpen: () => void }) {
  const revision = useApp((s) => s.revision);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void documentDataUrl(doc, true).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [doc.id, doc.path, revision]);

  const pending = isPending('attachments', doc.id);

  return (
    <button type="button" className="thumb" onClick={onOpen}>
      {url ? <img src={url} alt={doc.title} /> : <Icon name="doc" size={28} />}
      <span className="thumb-title">{doc.title}</span>
      {pending ? <span className="thumb-dot" title="Ожидает отправки" /> : null}
    </button>
  );
}

function ViewerContent({ doc }: { doc: DocumentRow }) {
  const revision = useApp((s) => s.revision);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const [url, setUrl] = useState<string | null>(null);
  const [title, setTitle] = useState(doc.title);

  useEffect(() => {
    void documentDataUrl(doc, false).then(setUrl);
  }, [doc.id, doc.path, revision]);

  return (
    <>
      <div className="viewer">
        {url ? <img src={url} alt={doc.title} /> : <Empty text="Файл не найден на устройстве" />}
      </div>
      <div className="row wrap">
        <Badge tone={isPending('attachments', doc.id) ? 'warn' : 'ok'}>
          {isPending('attachments', doc.id) ? 'Ожидает отправки' : 'В облаке'}
        </Badge>
        <Badge>{fmtNumber(Math.round((doc.size ?? 0) / 1024))} КБ</Badge>
        <Badge>{fmtDateTime(doc.created_at)}</Badge>
      </div>
      <Field label="Подпись">
        <div className="row">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} />
          <Button
            icon="check"
            onClick={() => {
              void renameDocument(doc.id, title).then(() => {
                touch();
                notify('Подпись сохранена', 'ok');
              });
            }}
          />
        </div>
      </Field>
    </>
  );
}

async function openExternally(
  doc: DocumentRow,
  notify: (text: string, kind?: 'ok' | 'err' | 'info') => void,
): Promise<void> {
  const url = await documentDataUrl(doc, false);
  if (!url) {
    notify('Файл не найден на устройстве', 'err');
    return;
  }
  const win = window.open();
  if (win) {
    win.document.write(`<title>${doc.title}</title><img src="${url}" style="max-width:100%" />`);
    win.document.close();
  } else {
    notify('Не удалось открыть окно', 'err');
  }
}
