const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { logger } = require('./logger');

// File I/O Helper
class FileHelper {
  static async loadJSON(filePath, defaultValue = null) {
    try {
      if (fsSync.existsSync(filePath)) {
        const data = await fs.readFile(filePath, 'utf8');
        try {
          return JSON.parse(data);
        } catch (parseError) {
          logger('error', `Error parsing JSON from ${filePath}: ${parseError.message}`);
          return defaultValue;
        }
      }
      return defaultValue;
    } catch (error) {
      logger('error', `Error loading ${filePath}: ${error.message}`);
      return defaultValue;
    }
  }
  
  static async saveJSON(filePath, data) {
    try {
      // Ensure directory exists
      const dir = path.dirname(filePath);
      if (dir && dir !== '.') {
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch (err) {
          // Ignore if directory already exists
          if (err.code !== 'EEXIST') {
            throw err;
          }
        }
      }
      
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      return true;
    } catch (error) {
      logger('error', `Error saving to ${filePath}: ${error.message}`);
      return false;
    }
  }
}

module.exports = FileHelper;
