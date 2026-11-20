/**
 * Ядро базы данных. Используется SQLite (сборка sql.js, WebAssembly),
 * поэтому база одинакова и на телефоне, и в браузере.
 * После изменений база сохраняется в файл (телефон) или IndexedDB (браузер).
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';
import { createPersister, type Persister } from './storage';

export type SqlValue = string | number | null | Uint8Array;

let SQL: SqlJsStatic | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let saveErrorHandler: ((error: unknown) => void) | null = null;

/** Куда сообщать, если базу не удалось записать на устройство */
export function setSaveErrorHandler(fn: ((error: unknown) => void) | null): void {
  saveErrorHandler = fn;
}

export class Db {
  private db: Database;
  private persister: Persister;
  private saving = false;
  private dirty = false;
  private inTx = false;
  /** База на устройстве не читается: до решения пользователя файл не трогаем */
  private blocked: string | null;
  private lastSaveError = '';

  private constructor(db: Database, persister: Persister, blocked: string | null = null) {
    this.db = db;
    this.persister = persister;
    this.blocked = blocked;
  }

  static async open(): Promise<Db> {
    if (!SQL) {
      SQL = await initSqlJs({ locateFile: () => new URL('sql-wasm.wasm', document.baseURI).href });
    }
    const persister = createPersister();
    const saved = await persister.load();
    const problem = persister.problem();
    const db = saved && saved.length > 0 ? new SQL.Database(saved) : new SQL.Database();
    const inst = new Db(db, persister, problem);
    inst.migrate();
    // Копию обновляем только у непустой базы: иначе после случайной очистки
    // пустая база затрёт последнюю целую копию.
    if (saved) await inst.refreshBackup();
    // Пустую базу сохраняем только если файла не было вовсе. Если файл есть,
    // но прочитать его не удалось, писать поверх нельзя — иначе данные пропадут.
    if (!saved && !problem) await inst.flush();
    return inst;
  }

  /** Что случилось с базой на устройстве (null — всё в порядке) */
  loadProblem(): string | null {
    return this.blocked;
  }

  /** Есть ли изменения, которые ещё не легли на диск: по этому видно «Сохраняю…» */
  hasUnsaved(): boolean {
    return this.dirty || this.saving;
  }

  /** Смириться с пустой базой: непрочитанный файл откладываем в сторону */
  async acceptEmptyBase(): Promise<string | null> {
    const parked = await this.persister.parkBroken();
    this.blocked = null;
    await this.flush();
    return parked;
  }

  /** Копия базы на устройстве */
  backupInfo() {
    return this.persister.backupInfo();
  }

  /** Сколько записей в базе (настройки не считаем) */
  rowCount(): number {
    const tables = ['companies', 'cargo_types', 'fuel_stations', 'places', 'vehicles', 'waybills', 'trips', 'trip_points', 'refuelings', 'finance_ops'];
    try {
      const sql = tables.map((t) => `(SELECT count(*) FROM ${t})`).join(' + ');
      const res = this.db.exec(`SELECT ${sql}`);
      return res.length > 0 ? Number(res[0].values[0][0]) : 0;
    } catch {
      return 0;
    }
  }

  /** Обновить копию базы, если в ней что-то есть. true — копия обновлена */
  async refreshBackup(): Promise<boolean> {
    if (this.blocked) return false;
    if (this.rowCount() === 0) return false;
    try {
      await this.persister.writeBackup(this.db.export());
      return true;
    } catch {
      return false;
    }
  }

  /** Сделать копию текущего состояния базы */
  async snapshot(): Promise<void> {
    if (this.blocked) return;
    await this.flush();
    await this.persister.snapshot();
  }

  /** Вернуть базу из копии (применяется после перезапуска приложения) */
  restoreBackup(): Promise<boolean> {
    return this.persister.restoreBackup();
  }

  private migrate() {
    const res = this.db.exec('PRAGMA user_version');
    const current = res.length > 0 ? Number(res[0].values[0][0]) : 0;
    if (current >= MIGRATIONS.length) {
      this.db.run('PRAGMA foreign_keys = ON');
      return;
    }
    this.db.run('BEGIN');
    try {
      for (let v = current; v < MIGRATIONS.length; v++) this.db.run(MIGRATIONS[v]);
      this.db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.db.run('PRAGMA foreign_keys = ON');
  }

  schemaVersion() {
    return SCHEMA_VERSION;
  }

  storageDescription() {
    return this.persister.describe();
  }

  all<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  one<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): T | null {
    const rows = this.all<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  run(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params);
    this.touch();
  }

  runMany(sql: string, params: SqlValue[] = []): void {
    const stmt = this.db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
    this.touch();
  }

  /** Пакет изменений одной транзакцией */
  tx(fn: () => void): void {
    this.db.run('BEGIN');
    this.inTx = true;
    try {
      fn();
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
    }
    this.touch();
  }

  export(): Uint8Array {
    return this.db.export();
  }

  private touch() {
    this.dirty = true;
    // во время транзакции базу на диск не пишем: дождёмся коммита
    if (this.inTx) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void this.flush().catch((e) => console.error('Не удалось сохранить базу', e));
    }, 800);
  }

  /** Немедленно записать базу на диск */
  async flush(): Promise<void> {
    if (this.saving) return;
    // Файл на устройстве не читается — писать поверх него нельзя
    if (this.blocked) return;
    this.saving = true;
    this.dirty = false;
    let failed = false;
    try {
      await this.persister.save(this.db.export());
      this.lastSaveError = '';
    } catch (e) {
      failed = true;
      this.dirty = true;
      const text = e instanceof Error ? e.message : String(e);
      console.error('Не удалось сохранить базу', e);
      // Об ошибке сообщаем один раз, повтор — при следующем изменении
      if (text !== this.lastSaveError) {
        this.lastSaveError = text;
        saveErrorHandler?.(e);
      }
    } finally {
      this.saving = false;
      // Изменения, случившиеся во время записи, дописываем сразу,
      // но после ошибки ждём следующего изменения — иначе будет бесконечный круг
      if (this.dirty && !failed) this.touch();
    }
  }

  /** Заменить всю базу (используется при импорте) */
  async replaceWith(bytes: Uint8Array): Promise<void> {
    this.db.close();
    if (!SQL) throw new Error('База не инициализирована');
    this.db = new SQL.Database(bytes);
    this.migrate();
    // Пользователь сам заменил базу: непрочитанный файл откладываем в сторону
    if (this.blocked) {
      await this.persister.parkBroken();
      this.blocked = null;
    }
    await this.flush();
  }

  close() {
    this.db.close();
  }
}

let instance: Db | null = null;

export async function getDb(): Promise<Db> {
  if (!instance) instance = await Db.open();
  return instance;
}

export function dbSync(): Db {
  if (!instance) throw new Error('База ещё не открыта');
  return instance;
}
