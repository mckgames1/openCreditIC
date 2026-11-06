'use strict';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`Node.js 22.5 veya ustu gerekli. Bulunan: ${process.version}`);
  process.exit(1);
}
try { require('node:sqlite'); }
catch (error) { console.error(`Node SQLite kullanilamiyor: ${error.message}`); process.exit(1); }
if (process.argv.includes('--dependencies')) {
  for (const name of ['express', 'pug', 'moment', 'request']) {
    try { require.resolve(name); }
    catch (_) { console.error(`${name} bulunamadi. KURULUM.bat dosyasini calistirin.`); process.exit(1); }
  }
}
console.log(`Node.js ${process.version} ve SQLite hazir.`);
