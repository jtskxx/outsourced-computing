const http = require('http');
const https = require('https');
const { logger } = require('./logger');

// Network Helper for buffered reading
class NetworkHelper {
  static setupBufferedSocket(socket, messageHandler, options = {}) {
    const CONFIG = require('../config/config');
    const maxBufferSize = options.maxBufferSize || CONFIG.bufferLimit;
    let buffer = '';
    
    socket.on('data', (data) => {
      try {
        // Append new data to buffer as string
        buffer += data.toString();
        
        // Safety check to prevent memory DOS attacks
        if (buffer.length > maxBufferSize) {
          logger('warn', `Buffer overflow for ${socket.remoteAddress}:${socket.remotePort}, closing connection`);
          socket.end('Buffer overflow');
          buffer = '';
          return;
        }
        
        // Split buffer by newlines and process complete lines
        const lines = buffer.split('\n');
        
        // Keep the last line which might be incomplete
        buffer = lines.pop() || '';
        
        // Process all complete lines
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine) {
            try {
              // Make sure we have valid JSON before parsing
              if (trimmedLine.startsWith('{') && trimmedLine.endsWith('}')) {
                const message = JSON.parse(trimmedLine);
                messageHandler(message);
              } else if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
                const message = JSON.parse(trimmedLine);
                messageHandler(message);
              } else {
                // Skip malformed JSON without logging 
                continue;
              }
            } catch (error) {
              // Only log if it looked like valid JSON but failed to parse
              if ((trimmedLine.startsWith('{') && trimmedLine.endsWith('}')) || 
                  (trimmedLine.startsWith('[') && trimmedLine.endsWith(']'))) {
                logger('debug', `JSON parse error for what looked like valid JSON: ${error.message}`);
              }
            }
          }
        }
      } catch (error) {
        logger('error', `Buffer processing error: ${error.message}`);
      }
    });
    
    return socket;
  }
  
  static httpFetch(url) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      
      const req = protocol.get(url, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve({ 
                statusCode: res.statusCode, 
                data: data,
                headers: res.headers
              });
            } catch (error) {
              reject(new Error(`Error parsing response: ${error.message}`));
            }
          } else {
            reject(new Error(`HTTP error: ${res.statusCode}`));
          }
        });
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      // Set timeout
      req.setTimeout(10000, () => {
        req.abort();
        reject(new Error('Request timeout'));
      });
    });
  }
}

module.exports = NetworkHelper;
