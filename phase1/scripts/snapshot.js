'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Creates a consistent SQLite snapshot at a new path; never restores over a live DB.
function snapshot(source, destination) {
  const input = path.resolve(source);
  const output = path.resolve(destination);
  if (!fs.existsSync(input)) throw new Error(`Kaynak veritabanı bulunamadı: ${input}`);
  for (const target of [output, `${output}-wal`, `${output}-shm`, `${output}-journal`]) {
    if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) throw new Error(`Hedef veya yan dosyası zaten var; üzerine yazılmadı: ${target}`);
  }
  if (input === output) throw new Error('Kaynak ve hedef aynı olamaz.');
  const db = new DatabaseSync(input, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Kaynak SQLite bütünlük kontrolünden geçmedi.');
    const schema = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('schema_migrations', 'accounts', 'ledger_entries', 'pulse_commands')").get();
    if (schema.n !== 4) throw new Error('Kaynak Faz 1 demo veritabanı değil.');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    // Reserve the exact path atomically; SQLite accepts our newly created empty file.
    fs.closeSync(fs.openSync(output, 'wx', 0o600));
    db.exec(`VACUUM INTO '${output.replaceAll("'", "''")}'`);
  } finally { db.close(); }
  return output;
}

module.exports = { snapshot };
