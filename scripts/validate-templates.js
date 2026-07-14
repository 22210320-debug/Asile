const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const viewsDirectory = path.join(__dirname, '..', 'views');
const templates = fs.readdirSync(viewsDirectory).filter((file) => file.endsWith('.ejs'));

for (const template of templates) {
  const filePath = path.join(viewsDirectory, template);
  ejs.compile(fs.readFileSync(filePath, 'utf8'), { filename: filePath });
}

console.log(`Validated ${templates.length} EJS templates.`);
