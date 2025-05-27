const net = require('net');
const CONFIG = require('../config/config');
const { logger } = require('../utils/logger');


class TaskSourceClient {
  constructor(state) {
    this.state = state;
    this.socket = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.buffer = '';
  }
  
  connect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
    }
    
    clearTimeout(this.reconnectTimer);
    this.buffer = '';
    
    this.socket = new net.Socket();
    
    this.socket.connect(CONFIG.taskSourcePort, CONFIG.taskSourceHost, () => {
      logger('info', `Connected to task source ${CONFIG.taskSourceHost}:${CONFIG.taskSourcePort}`);
      this.connected = true;
      this.state.recordSuccess('taskSource');
    });
    
    // Parse incoming data
    this.socket.on('data', (data) => this.handleData(data));
    
    this.socket.on('error', (err) => {
      logger('error', `Task source socket error: ${err.message}`);
      this.connected = false;
      this.state.recordFailure('taskSource');
      this.scheduleReconnect();
    });
    
    this.socket.on('end', () => {
      logger('warn', `Task source connection ended`);
      this.connected = false;
      this.scheduleReconnect();
    });
    
    this.socket.on('close', () => {
      this.connected = false;
      this.scheduleReconnect();
    });
  }
  
  handleData(data) {
    try {
      this.buffer += data.toString();
      
      // Buffer overflow protection
      if (this.buffer.length > CONFIG.bufferLimit) {
        logger('warn', `Buffer overflow from task source, resetting connection`);
        this.buffer = '';
        this.socket.destroy();
        return;
      }
      
      while (true) {
        let parsed;
        let remainingBuffer;
        
        try {
          parsed = JSON.parse(this.buffer);
          remainingBuffer = '';
        } catch (e) {
          // Find complete JSON
          let depth = 0;
          let foundEnd = -1;
          
          for (let i = 0; i < this.buffer.length; i++) {
            if (this.buffer[i] === '{') depth++;
            if (this.buffer[i] === '}') depth--;
            
            if (depth === 0 && this.buffer[i] === '}') {
              foundEnd = i;
              break;
            }
          }
          
          if (foundEnd === -1) {
            break;
          }
          
          let jsonStr = this.buffer.substring(0, foundEnd + 1);
          remainingBuffer = this.buffer.substring(foundEnd + 1);
          
          try {
            parsed = JSON.parse(jsonStr);
          } catch (e) {
            logger('debug', `Task source parse error: ${e.message}`);
            this.buffer = remainingBuffer;
            continue;
          }
        }
        
        this.handleMessage(parsed);
        this.buffer = remainingBuffer;
        
        if (!this.buffer.trim()) {
          break;
        }
      }
    } catch (error) {
      logger('error', `Task source data handling error: ${error.message}`);
    }
  }
  
  scheduleReconnect() {
    if (!this.reconnectTimer) {
      logger('info', `Scheduling task source reconnect in 5 seconds...`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.state.isCircuitOpen('taskSource')) {
          this.connect();
        } else {
          logger('warn', `Task source circuit open, delaying reconnect`);
          this.scheduleReconnect();
        }
      }, 5000);
    }
  }
  
  handleMessage(message) {
    try {
      const startTime = Date.now();
      

      if (CONFIG.verbose) {
        logger('debug', `Received task type: ${message.method || 'Unknown'}`);
      }
      
      if (message.method === 'job') {
        if (message.job && message.job.job_id && message.job.job_id === this.state.lastJobId) {
          logger('debug', `Ignoring duplicate job ID: ${message.job.job_id}`);
          return;
        }
        
        // Stats tracking
        this.state.taskStats.processed++;
        this.state.taskStats.lastProcessed = new Date().toISOString();
        
        // Defaults
        message.job.first_computor_index = message.job.first_computor_index || 0;
        message.job.last_computor_index = message.job.last_computor_index || 675;
        

        const activeJobCount = this.state.activeJobs ? this.state.activeJobs.size : 0;
        logger('job', `New job: ${message.job.job_id}, height: ${message.job.height}, range: ${message.job.first_computor_index}-${message.job.last_computor_index}, active jobs: ${activeJobCount + 1}`);
        
        // Check for valid computors
        const rangeKey = `${message.job.first_computor_index}-${message.job.last_computor_index}`;
        let hasValidComputors = false;
        
        if (this.state.computors.validComputorsCache && this.state.computors.validComputorsCache.has(rangeKey)) {
          hasValidComputors = this.state.computors.validComputorsCache.get(rangeKey).length > 0;
        } else {
          // Cache for later
          const validComputors = this.state.computors.getDistribution().filter(
            item => item.index >= message.job.first_computor_index && 
                   item.index <= message.job.last_computor_index
          );
          
          if (this.state.computors.validComputorsCache) {
            this.state.computors.validComputorsCache.set(rangeKey, validComputors);
          }
          
          hasValidComputors = validComputors.length > 0;
        }
        
        if (!hasValidComputors) {
          logger('job', `No valid computors for job in range ${message.job.first_computor_index}-${message.job.last_computor_index}, not mining`);
          this.state.taskStats.skipped++;
          // Store anyway
          this.state.jobs.storeRecentJob(message);
        } else {

          this.state.taskStats.mined++;

          this.state.emit('job', message);
        }
        

        const processingTime = Date.now() - startTime;
        this.state.taskStats.processingTimes.push(processingTime);
        
        // Keep last 100
        if (this.state.taskStats.processingTimes.length > 100) {
          this.state.taskStats.processingTimes.shift();
        }
      }
    } catch (error) {
      logger('error', `Error processing task message: ${error.message}`);
    }
  }
}

module.exports = TaskSourceClient;
