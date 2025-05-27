const net = require('net');
const CONFIG = require('../config/config');
const NetworkHelper = require('../utils/NetworkHelper');
const { logger } = require('../utils/logger');

class ShareDistributionServer {
  constructor(state) {
    this.state = state;
    this.server = null;
    this.clients = new Set();
    
    this.state.on('distributionShare', (share) => {
      this.distributeShare(share);
    });
  }
  
  start() {
    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });
    
    this.server.on('error', (err) => {
      logger('error', `Share server error: ${err.message}`);
    });
    
    this.server.listen(CONFIG.shareDistributionPort, '127.0.0.1', () => {
      logger('info', `Share distribution server listening on port ${CONFIG.shareDistributionPort}`);
    });
  }
  
  handleConnection(socket) {
    logger('info', `Share client connected: ${socket.remoteAddress}:${socket.remotePort}`);
    this.clients.add(socket);
    
    // Setup buffered socket processing
    NetworkHelper.setupBufferedSocket(socket, (message) => {
      logger('debug', `Received from share client: ${JSON.stringify(message)}`);
    });
    
    socket.on('end', () => {
      this.handleClientDisconnect(socket);
    });
    
    socket.on('error', (err) => {
      logger('error', `Share client error: ${err.message}`);
      this.clients.delete(socket);
    });
    
    socket.on('close', () => {
      this.handleClientDisconnect(socket);
    });
  }
  
  handleClientDisconnect(socket) {
    logger('info', `Share client disconnected: ${socket.remoteAddress}:${socket.remotePort}`);
    this.clients.delete(socket);
  }
  
  distributeShare(message) {
    let distributedTo = 0;
    const messageString = JSON.stringify(message) + '\n';
    
    // Log incoming share for distribution
    const nonce = message.params && message.params.nonce ? message.params.nonce : 'unknown';
    logger('info', `[ShareDistribution] Distributing share - nonce: ${nonce}, computor: ${message.computorIndex}, clients: ${this.clients.size}`);
    
    for (const client of this.clients) {
      if (client.writable) {
        try {
          client.write(messageString);
          distributedTo++;
        } catch (error) {
          logger('error', `Error distributing share to client: ${error.message}`);
          this.clients.delete(client);
        }
      } else {
        this.clients.delete(client);
      }
    }
    
    logger('debug', `Share distributed to ${distributedTo} clients`);
    logger('debug', `Share distribution details: task_id: ${message.task_id}, hash: ${message.task_seed_hash}, computor: ${message.computorIndex}`);
    
    if (distributedTo === 0 && this.clients.size === 0) {
      logger('warn', `No share clients connected`);
    }
  }
  
  getClientCount() {
    return this.clients.size;
  }
}

module.exports = ShareDistributionServer;
