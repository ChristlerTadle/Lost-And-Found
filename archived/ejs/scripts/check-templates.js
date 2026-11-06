const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

function findTemplates(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? findTemplates(fullPath) : (fullPath.endsWith('.ejs') ? [fullPath] : []);
  });
}

for (const file of findTemplates(path.resolve(__dirname, '..', 'views'))) {
  ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
  console.log(`EJS OK ${path.relative(process.cwd(), file)}`);
}
