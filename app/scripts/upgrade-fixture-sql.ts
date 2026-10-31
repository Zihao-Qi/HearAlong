// Text transport for the frozen upgrade fixture, using the app's own node:sqlite library.
// This only reads the old writer's database; it does not invent or migrate application rows.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
type Schema = { type: string; name: string; sql: string };
function schema(db: DatabaseSync): Schema[] {
  return db.prepare(`SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`).all().map(row => ({ ...row })) as Schema[];
}
function tableRows(db: DatabaseSync, table: Schema) {
  // v0.1.0 has ordinary rowid tables. Preserve rowids too: some released queries use insertion order as a tie-break.
  assert.doesNotMatch(table.sql, /WITHOUT\s+ROWID/i, 'The frozen v0.1.0 dump expects rowid tables.');
  assert.ok(!table.name.startsWith('sqlite_'), 'Internal SQLite tables need explicit dump support.');
  const columns = (db.prepare(`PRAGMA table_info(${identifier(table.name)})`).all() as { name: string }[]).map(c => c.name);
  assert.ok(!columns.some(name => ['rowid', '_rowid_', 'oid'].includes(name.toLowerCase())), 'Do not shadow SQLite rowids.');
  // SQLite's quote() retains storage types, escapes apostrophes and emits blob literals without a shell dependency.
  // It truncates text at NUL; reject that unsupported case rather than silently changing the dump.
  for (const column of columns) {
    assert.equal(db.prepare(`SELECT 1 FROM ${identifier(table.name)} WHERE typeof(${identifier(column)})='text'
      AND instr(${identifier(column)}, char(0)) > 0 LIMIT 1`).get(), undefined, 'Fixture text must not contain NUL.');
  }
  const names = ['_rowid_', ...columns];
  const select = names.map((name, i) => `quote(${identifier(name)}) AS ${identifier(`c${i}`)}`).join(', ');
  const rows = db.prepare(`SELECT ${select} FROM ${identifier(table.name)} ORDER BY _rowid_`).all()
    .map(row => names.map((_, i) => row[`c${i}`] as string));
  return { columns: names, rows };
}
function pragmas(db: DatabaseSync) {
  return {
    userVersion: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    applicationId: (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id,
  };
}

/** Per-table content hashes include every column's SQL literal and rowid, in rowid order, even for empty tables. */
export function databaseSnapshot(db: DatabaseSync) {
  const definitions = schema(db);
  return { ...pragmas(db), schema: definitions, tables: Object.fromEntries(definitions.filter(s => s.type === 'table').map(table => {
    const { columns, rows } = tableRows(db, table);
    return [table.name, { rows: rows.length, sha256: createHash('sha256').update(JSON.stringify({ columns, rows })).digest('hex') }];
  })) };
}

/** Stable ordering for the same old-writer database: schema kind/name, then each table's original rowids. */
export function dumpDatabase(db: DatabaseSync): string {
  const definitions = schema(db), { userVersion, applicationId } = pragmas(db);
  const lines = ['-- v0.1.0 writer output; generated with node:sqlite, not hand-authored application data.',
    'PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;', `PRAGMA user_version=${userVersion};`, `PRAGMA application_id=${applicationId};`];
  for (const table of definitions.filter(s => s.type === 'table')) {
    lines.push(`${table.sql};`);
    const { columns, rows } = tableRows(db, table);
    for (const row of rows) lines.push(`INSERT INTO ${identifier(table.name)} (${columns.map(identifier).join(', ')}) VALUES (${row.join(', ')});`);
  }
  for (const definition of definitions.filter(s => s.type !== 'table')) lines.push(`${definition.sql};`);
  return [...lines, 'COMMIT;', 'PRAGMA foreign_keys=ON;', ''].join('\n');
}
