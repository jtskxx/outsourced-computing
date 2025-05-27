const CONFIG = require('../config/config');


function logger(level, message) {
  const timestamp = new Date().toISOString();
  

  if (!CONFIG.logLevels || !CONFIG.logLevels[level]) {
    return;
  }
  

  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  

  console.log(logMessage);
}


function formatHashrate(hashrate) {
  if (hashrate >= 1e9) {
    return `${(hashrate / 1e9).toFixed(2)} GH/s`;
  } else if (hashrate >= 1e6) {
    return `${(hashrate / 1e6).toFixed(2)} MH/s`;
  } else if (hashrate >= 1e3) {
    return `${(hashrate / 1e3).toFixed(2)} KH/s`;
  } else {
    return `${hashrate.toFixed(2)} H/s`;
  }
}

module.exports = {
  logger,
  formatHashrate
};
