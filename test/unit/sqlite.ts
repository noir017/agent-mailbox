// node:sqlite behind the store's Sql interface, counting the rows each statement changes —
// the closest local stand-in for the "rows written" a Durable Object is billed for.
import { DatabaseSync } from 'node:sqlite';
import type { Row, Sql, SqlValue } from '../../src/store.js';

export interface CountingSql extends Sql {
  written: number;
  db: DatabaseSync;
}

export function memorySql(db = new DatabaseSync(':memory:')): CountingSql {
  const sql: CountingSql = {
    written: 0,
    db,
    exec(query: string, ...params: SqlValue[]): Row[] {
      const stmt = db.prepare(query);
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) {
        sql.written += Number(stmt.run(...params).changes);
        return [];
      }
      return stmt.all(...params) as Row[];
    },
  };
  return sql;
}
