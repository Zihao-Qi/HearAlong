import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { databaseSnapshot, dumpDatabase } from '../scripts/upgrade-fixture-sql.ts';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA user_version=3; PRAGMA application_id=42;
    CREATE TABLE parent (id INTEGER PRIMARY KEY, text TEXT, bytes BLOB, number REAL);
    CREATE TABLE child (id TEXT PRIMARY KEY, parent INTEGER REFERENCES parent(id), optional TEXT);
    CREATE TABLE empty (id TEXT PRIMARY KEY);
    CREATE INDEX child_parent ON child(parent);
    CREATE VIEW parents AS SELECT id, text FROM parent;`);
  const insert = db.prepare('INSERT INTO parent VALUES (?,?,?,?)');
  insert.run(7, "Fictional club's cupboard\nSecond line.", Buffer.from([0, 1, 255]), 1.25);
  insert.run(2, null, null, null);
  db.prepare('INSERT INTO child (rowid,id,parent,optional) VALUES (?,?,?,?)').run(42, 'fictional-child', 7, '');
  return db;
}

test('upgrade SQL dump deterministically preserves schema, every row, rowids, types and version metadata', () => {
  const original = database(), rebuilt = new DatabaseSync(':memory:');
  try {
    const sql = dumpDatabase(original);
    assert.equal(sql, dumpDatabase(original), 'same database always has the same dump ordering');
    assert.ok(sql.indexOf('CREATE TABLE child') < sql.indexOf('CREATE TABLE empty'));
    assert.ok(sql.includes("club''s cupboard"), 'SQL text remains readable and apostrophes are escaped');
    assert.match(sql, /X'0001FF'/i, 'SQLite quote() preserves blob bytes');
    rebuilt.exec(sql);
    assert.deepEqual(databaseSnapshot(rebuilt), JSON.parse(JSON.stringify(databaseSnapshot(original))), 'also matches the JSON-serialized generator oracle');
    assert.equal(databaseSnapshot(rebuilt).tables.empty.rows, 0, 'empty tables are included');
    assert.equal(rebuilt.prepare('SELECT rowid FROM child').get()?.rowid, 42);
    assert.deepEqual(rebuilt.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { original.close(); rebuilt.close(); }
});

test('upgrade database content digest detects changed values even when all row counts are unchanged', () => {
  const original = database(), rebuilt = new DatabaseSync(':memory:');
  try {
    const expected = databaseSnapshot(original);
    rebuilt.exec(dumpDatabase(original));
    rebuilt.prepare('UPDATE child SET optional=?').run('Fictional corruption.');
    const changed = databaseSnapshot(rebuilt);
    assert.equal(changed.tables.child.rows, expected.tables.child.rows);
    assert.notEqual(changed.tables.child.sha256, expected.tables.child.sha256);
    assert.notDeepEqual(changed, expected);
  } finally { original.close(); rebuilt.close(); }
});

test('upgrade SQL dump refuses NUL text rather than letting SQLite quote silently truncate it', () => {
  const db = database();
  try {
    db.prepare('UPDATE child SET optional=?').run('fictional\0text');
    assert.throws(() => dumpDatabase(db), /Fixture text must not contain NUL/);
    assert.throws(() => databaseSnapshot(db), /Fixture text must not contain NUL/);
  } finally { db.close(); }
});
