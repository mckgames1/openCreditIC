'use strict';

const path = require('node:path');
const { snapshot } = require('./snapshot');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const databasePath = path.resolve(arg('--database', process.env.PHASE1_DB_PATH || path.join(process.cwd(), 'phase1-data', 'demo.sqlite')));
const outputPath = path.resolve(arg('--output', path.join(process.cwd(), 'phase1-backups', `demo-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)));

try {
  console.log(`Yedek oluşturuldu: ${snapshot(databasePath, outputPath)}`);
} catch (error) { console.error(`Yedek oluşturulamadı: ${error.message}`); process.exitCode = 1; }
