'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const databasePath = path.resolve(arg('--database', process.env.PHASE1_DB_PATH || path.join(process.cwd(), 'phase1-data', 'demo.sqlite')));
const outputPath = path.resolve(arg('--output', path.join(process.cwd(), 'phase1-backups', `demo-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)));

if (!fs.existsSync(databasePath)) {
  console.error(`Veritabanı bulunamadı: ${databasePath}`);
  process.exit(1);
}
if (fs.existsSync(outputPath)) {
  console.error(`Yedek hedefi zaten var; üzerine yazılmadı: ${outputPath}`);
  process.exit(1);
}
if (databasePath === outputPath) {
  console.error('Yedek hedefi kaynak veritabanıyla aynı olamaz.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const db = new DatabaseSync(databasePath);
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const sqlPath = outputPath.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${sqlPath}'`);
  console.log(`Yedek oluşturuldu: ${outputPath}`);
} finally {
  db.close();
}
