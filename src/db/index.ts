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

export class Db {
  private db: Database;
  private persister: Persister;
  private saving = false;
  private dirty = false;

  private constructor(db: Database, persister: Persister) {
    this.db = db;
    this.persister = persister;
  }

  static async open(): Promise<Db> {
    if (!SQL) {
      SQL = await initSqlJs({ locateFile: () => new URL('sql-wasm.wasm', document.baseURI).href });
    }
    const persister = createPersister();
    const saved = await persister.load();
    const db = saved && saved.length > 0 ? new SQL.Database(saved) : new SQL.Database();
    const inst = new Db(db, persister);
    inst.migrate();
    if (!saved) await inst.flush();
    return inst;
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
    try {
      fn();
      this.db.run('COMMIT');
      this.touch();
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
  }

  export(): Uint8Array {
    return this.db.export();
  }

  private touch() {
    this.dirty = true;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void this.flush().catch((e) => console.error('Не удалось сохранить базу', e));
    }, 800);
  }

  /** Немедленно записать базу на диск */
  async flush(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.dirty = false;
    try {
      await this.persister.save(this.db.export());
    } finally {
      this.saving = false;
      if (this.dirty) this.touch();
    }
  }

  /** Заменить всю базу (используется при импорте) */
  async replaceWith(bytes: Uint8Array): Promise<void> {
    this.db.close();
    if (!SQL) throw new Error('База не инициализирована');
    this.db = new SQL.Database(bytes);
    this.migrate();
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
