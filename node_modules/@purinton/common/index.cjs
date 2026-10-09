const fs = require('fs');
const log = require('@purinton/log').default || require('@purinton/log');
const pathModule = require('@purinton/path');
const path = pathModule.default || pathModule;
const pathUrl = pathModule.pathUrl;
const getCurrentDirname = pathModule.getCurrentDirname;
const getCurrentFilename = pathModule.getCurrentFilename;
const { registerHandlers } = require('@purinton/errors');
const { registerSignals } = require('@purinton/signals');

module.exports = {
  fs,
  log,
  path,
  pathUrl,
  getCurrentDirname,
  getCurrentFilename,
  registerHandlers,
  registerSignals,
};
