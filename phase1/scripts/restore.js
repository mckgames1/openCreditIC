'use strict';
const { snapshot } = require('./snapshot');
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
const source = arg('--source');
const output = arg('--output');
if (!source || !output || source.startsWith('--') || output.startsWith('--')) {
  console.error('Kullanım: npm run phase1:restore -- --source YEDEK --output YENI_DOSYA');
  process.exitCode = 1;
} else {
  try { console.log(`Yeni geri yükleme dosyası oluşturuldu: ${snapshot(source, output)}`); }
  catch (error) { console.error(`Geri yükleme başarısız: ${error.message}`); process.exitCode = 1; }
}
