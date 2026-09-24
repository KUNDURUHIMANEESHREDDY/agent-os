const { Sequelize } = require('sequelize');
const path = require('path');
const fs = require('fs');

// Writable location for the sqlite file. In the hardened container the image
// is read-only, so compose mounts a volume at STUDIO_DATA_DIR (/srv/studio/data).
const dataDir = process.env.STUDIO_DATA_DIR || path.join(__dirname, '..');
try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: process.env.STUDIO_DB || path.join(dataDir, 'promptchain_database.sqlite'),
  logging: false,
});

module.exports = sequelize;
