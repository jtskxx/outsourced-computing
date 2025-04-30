const net = require('net');
const http = require('http');
const fs = require('fs');
const https = require('https');
const path = require('path');

// Edit these values as needed
const CONFIG = {
  // Connection settings
  taskSourceHost: 'localhost',
  taskSourcePort: 8765,
  minerPort: 3333,
  shareDistributionPort: 8766,
  statsPort: 8088,
  
  // Admin authentication
  adminPassword: 'yourSecurePassword', // Change this to your preferred password
  
  // Stat files
  statsPath: './stats.json',
  statsInterval: 30000, // 30 seconds
  persistentStatsPath: './persistent_stats.json',
  persistentStatsInterval: 150000, // 2.5 minutes
  
  // Miner settings
  verbose: false,
  keepaliveTimeout: 600000, // 10 minutes
  keepaliveInterval: 30000,
  hashrateWindow: 600000, // 10 minutes
  xmrShareDifficulty: 480045,
  
  // Reset schedule (Wednesday at 12PM UTC NEW QUBIC EPOCH)
  resetDay: 3,
  resetHour: 12,
  resetMinute: 0,
  
  // Qubic-specific settings
  computorSettingsPath: './computor_settings.json',
  computorIndexesPath: './computor_indexes.json',
  nonceRangeSize: 155480000, // Size for a 7950X CPU
  
  // New settings for multi-computor
  defaultEpoch: 158,
  rpcEndpoint: 'rpc.qubic.org'
};

// Global state
const miners = new Map();
const workerStats = new Map();
let totalShares = 0;
let lastShareReset = null;
let currentJob = null;
let lastJobId = null;
let nextNonceStartValue = 0;

// New multi-computor state
let computorDistribution = []; // Array of {index, weight, identity}
let computorIdentities = []; // Array of identities from the API
let currentEpoch = CONFIG.defaultEpoch;

function getNextComputorIndex() {
  if (computorDistribution.length === 0) {
    return 0; // Default if no distribution defined
  }
  
  // Use weighted random selection
  const totalWeight = computorDistribution.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;
  
  for (const item of computorDistribution) {
    random -= item.weight;
    if (random <= 0) {
      return item.index;
    }
  }
  
  // Fallback to first item
  return computorDistribution[0].index;
}

function initializeNonce() {
  nextNonceStartValue = Math.floor(Math.random() * 2147483648);
  console.log(`[NONCE] Initialized next nonce start value to ${nextNonceStartValue}`);
}

function loadComputorSettings() {
  try {
    // Load computor distribution
    if (fs.existsSync(CONFIG.computorIndexesPath)) {
      const data = fs.readFileSync(CONFIG.computorIndexesPath, 'utf8');
      computorDistribution = JSON.parse(data);
      console.log(`[SETTINGS] Loaded computor distribution with ${computorDistribution.length} entries`);
    } else {
      // Initialize with default
      computorDistribution = [{
        index: 0,
        weight: 100,
        identity: null
      }];
      console.log(`[SETTINGS] No distribution file found, using default index: 0 with 100% weight`);
      saveComputorDistribution();
    }
  } catch (error) {
    console.error('[SETTINGS] Error loading settings:', error);
    // Initialize with default
    computorDistribution = [{
      index: 0,
      weight: 100,
      identity: null
    }];
    console.log(`[SETTINGS] Using default distribution due to error`);
  }
}

function saveComputorDistribution() {
  fs.writeFile(CONFIG.computorIndexesPath, JSON.stringify(computorDistribution, null, 2), (err) => {
    if (err) {
      console.error('[SETTINGS] Error saving computor distribution:', err);
    } else if (CONFIG.verbose) {
      console.log(`[SETTINGS] Computor distribution saved`);
    }
  });
}

function savePersistentStats() {
  const persistentData = {
    totalShares,
    lastShareReset,
    workers: Array.from(workerStats.entries()).map(([key, data]) => {
      const cleanedData = JSON.parse(JSON.stringify(data));
      
      // Remove fields we don't want to persist
      delete cleanedData.firstSeen;
      delete cleanedData.totalConnections;
      delete cleanedData.activeConnections;
      
      return [key, cleanedData];
    }),
    savedAt: new Date().toISOString()
  };
  
  // Ensure directory exists
  const dir = CONFIG.persistentStatsPath.substring(0, CONFIG.persistentStatsPath.lastIndexOf('/'));
  if (dir && dir !== '.') {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      console.error(`[PERSISTENCE] Error creating directory ${dir}:`, err);
    }
  }
  
  fs.writeFile(CONFIG.persistentStatsPath, JSON.stringify(persistentData, null, 2), (err) => {
    if (err) {
      console.error('[PERSISTENCE] Error saving persistent stats:', err);
    } else if (CONFIG.verbose) {
      console.log('[PERSISTENCE] Stats saved');
    }
  });
}

function loadPersistentStats() {
  try {
    if (fs.existsSync(CONFIG.persistentStatsPath)) {
      const data = fs.readFileSync(CONFIG.persistentStatsPath, 'utf8');
      const persistentData = JSON.parse(data);
      
      totalShares = persistentData.totalShares || 0;
      lastShareReset = persistentData.lastShareReset;
      
      if (persistentData.workers && Array.isArray(persistentData.workers)) {
        persistentData.workers.forEach(([key, data]) => {
          if (!data.firstSeen) {
            data.firstSeen = new Date().toISOString();
          }
          if (!data.totalConnections) {
            data.totalConnections = 0;
          }
          
          data.activeConnections = new Set();
          workerStats.set(key, data);
        });
      }
      
      console.log(`[PERSISTENCE] Loaded stats: ${workerStats.size} workers, ${totalShares} shares`);
      if (lastShareReset) {
        console.log(`[PERSISTENCE] Last reset: ${new Date(lastShareReset).toISOString()}`);
      }
    } else {
      console.log(`[PERSISTENCE] No stats file found`);
      if (!lastShareReset) {
        lastShareReset = new Date().toISOString();
      }
    }
  } catch (error) {
    console.error('[PERSISTENCE] Error loading stats:', error);
    console.log('[PERSISTENCE] Starting with fresh stats');
    
    if (!lastShareReset) {
      lastShareReset = new Date().toISOString();
    }
  }
}

function checkAndResetShares() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  
  if (day === CONFIG.resetDay && hour === CONFIG.resetHour && minute === CONFIG.resetMinute) {
    const lastResetTime = lastShareReset ? new Date(lastShareReset) : null;
    if (!lastResetTime || 
        lastResetTime.getUTCDay() !== day ||
        lastResetTime.getUTCHours() !== hour ||
        lastResetTime.getUTCMinutes() !== minute) {
      
      console.log(`[SHARE RESET] Weekly reset triggered at ${now.toISOString()}`);
      resetAllShares();
    }
  }
}

function resetAllShares() {
  const previousTotal = totalShares;
  totalShares = 0;
  
  let resetCount = 0;
  workerStats.forEach((workerStat, workerKey) => {
    if (workerStat.shares > 0) {
      resetCount++;
      workerStat.shares = 0;
      workerStat.shareHistory = [];
      workerStats.set(workerKey, workerStat);
    }
  });
  
  lastShareReset = new Date().toISOString();
  
  console.log(`[SHARE RESET] Reset ${resetCount} workers, previous total: ${previousTotal}`);
  savePersistentStats();
}

function sendKeepaliveToMiners() {
  miners.forEach((minerInfo, minerId) => {
    if (minerInfo.connected && minerInfo.socket && minerInfo.socket.writable) {
      minerInfo.lastActivity = Date.now();
      miners.set(minerId, minerInfo);
    }
  });
}

// Function to fetch computor list from API
function fetchComputorList(epoch, callback) {
  const url = `https://${CONFIG.rpcEndpoint}/v1/epochs/${epoch}/computors`;
  
  https.get(url, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result && result.computors && Array.isArray(result.computors.identities)) {
          computorIdentities = result.computors.identities;
          currentEpoch = epoch;
          console.log(`[API] Loaded ${computorIdentities.length} computor identities for epoch ${epoch}`);
          
          // Update existing distribution with identity information
          computorDistribution = computorDistribution.map(item => {
            if (item.index >= 0 && item.index < computorIdentities.length) {
              item.identity = computorIdentities[item.index];
            }
            return item;
          });
          
          saveComputorDistribution();
          callback(null, computorIdentities);
        } else {
          callback(new Error('Invalid API response format'), null);
        }
      } catch (error) {
        callback(new Error(`Error parsing API response: ${error.message}`), null);
      }
    });
  }).on('error', (err) => {
    callback(new Error(`API request failed: ${err.message}`), null);
  });
}

// Function to find index of a computor identity
function findComputorIndex(identity) {
  if (!computorIdentities.length) {
    return -1;
  }
  
  return computorIdentities.findIndex(id => id === identity);
}

function connectToTaskSource() {
  const taskClient = new net.Socket();
  
  taskClient.connect(CONFIG.taskSourcePort, CONFIG.taskSourceHost, () => {
    console.log(`[TASK SOURCE] Connected to ${CONFIG.taskSourceHost}:${CONFIG.taskSourcePort}`);
  });
  
  let buffer = '';
  
  taskClient.on('data', (data) => {
    try {
      buffer += data.toString();
      
      while (true) {
        let parsed;
        let remainingBuffer;
        
        try {
          parsed = JSON.parse(buffer);
          remainingBuffer = '';
        } catch (e) {
          let depth = 0;
          let foundEnd = -1;
          
          for (let i = 0; i < buffer.length; i++) {
            if (buffer[i] === '{') depth++;
            if (buffer[i] === '}') depth--;
            
            if (depth === 0 && buffer[i] === '}') {
              foundEnd = i;
              break;
            }
          }
          
          if (foundEnd === -1) {
            break;
          }
          
          let jsonStr = buffer.substring(0, foundEnd + 1);
          remainingBuffer = buffer.substring(foundEnd + 1);
          
          try {
            parsed = JSON.parse(jsonStr);
          } catch (e) {
            console.error('[TASK SOURCE] Error parsing JSON:', e);
            buffer = remainingBuffer;
            continue;
          }
        }
        
        if (CONFIG.verbose) {
          console.log(`[TASK SOURCE] Parsed: ${JSON.stringify(parsed)}`);
        } else {
          console.log(`[TASK SOURCE] Received type: ${parsed.method || 'Unknown'}`);
        }
        
        if (parsed.method === 'job') {
          if (parsed.job && parsed.job.job_id && parsed.job.job_id === lastJobId) {
            console.log(`[JOB] Ignoring duplicate job ID: ${parsed.job.job_id}`);
            continue;
          }
          
          currentJob = JSON.parse(JSON.stringify(parsed));
          
          console.log(`[JOB] New job: ${currentJob.job.job_id}, height: ${currentJob.job.height}`);
          
          lastJobId = currentJob.job.job_id;
          initializeNonce();
          
          // Select computor index based on distribution
          currentJob.job.computorIndex = getNextComputorIndex();
          
          console.log(`[QUBIC] Using computor index: ${currentJob.job.computorIndex} for job ${currentJob.job.job_id}`);
          
          broadcastToMiners();
        }
        
        buffer = remainingBuffer;
        
        if (!buffer.trim()) {
          break;
        }
      }
    } catch (error) {
      console.error('[TASK SOURCE] Error processing data:', error);
    }
  });
  
  taskClient.on('end', () => {
    console.log('[TASK SOURCE] Connection ended. Reconnecting...');
    setTimeout(connectToTaskSource, 5000);
  });
  
  taskClient.on('error', (err) => {
    console.error('[TASK SOURCE] Socket error:', err);
    setTimeout(connectToTaskSource, 5000);
  });
}

function getWorkerKey(wallet, workerName) {
  return `${wallet || 'unknown'}.${workerName || 'default'}`;
}

function getOrCreateWorkerStats(wallet, workerName) {
  const workerKey = getWorkerKey(wallet, workerName);
  
  if (!workerStats.has(workerKey)) {
    workerStats.set(workerKey, {
      wallet: wallet || 'unknown',
      workerName: workerName || 'default',
      shares: 0,
      shareHistory: [],
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      activeConnections: new Set()
    });
  }
  
  return workerStats.get(workerKey);
}

function calculateHashrate(shareHistory) {
  const now = Date.now();
  const windowStart = now - CONFIG.hashrateWindow;
  
  const recentShares = shareHistory.filter(timestamp => timestamp > windowStart);
  
  if (recentShares.length === 0) {
    return 0;
  }
  
  const avgDifficulty = CONFIG.xmrShareDifficulty;
  const windowSizeInSeconds = CONFIG.hashrateWindow / 1000;
  const hashrate = (recentShares.length * avgDifficulty) / windowSizeInSeconds;
  
  return hashrate;
}

function allocateNonceRange() {
  const start_nonce = nextNonceStartValue;
  const end_nonce = start_nonce + CONFIG.nonceRangeSize;
  
  nextNonceStartValue = end_nonce;
  
  return { start_nonce, end_nonce };
}

const minerServer = net.createServer((socket) => {
  const minerId = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[MINER] Connected: ${minerId}`);
  
  miners.set(minerId, {
    socket: socket,
    wallet: null,
    workerName: null,
    workerKey: null,
    shares: 0,
    connected: true,
    lastActivity: Date.now(),
    nonceRange: null
  });

  let minerBuffer = '';
  
  socket.on('data', (data) => {
    try {
      minerBuffer += data.toString();
      
      let messages = [];
      let start = 0;
      
      for (let i = 0; i < minerBuffer.length; i++) {
        if (minerBuffer[i] === '\n') {
          let line = minerBuffer.substring(start, i).trim();
          if (line) {
            try {
              let message = JSON.parse(line);
              messages.push(message);
            } catch (e) {
              console.error('[MINER] Parse error:', e);
              console.error('[MINER] Failed line:', line);
            }
          }
          start = i + 1;
        }
      }
      
      minerBuffer = minerBuffer.substring(start);
      
      for (const message of messages) {
        if (CONFIG.verbose) {
          console.log(`[MINER] Received from ${minerId}: ${JSON.stringify(message)}`);
        }
        
        const minerInfo = miners.get(minerId);
        if (minerInfo) {
          minerInfo.lastActivity = Date.now();
          miners.set(minerId, minerInfo);
        }
        
        if (message.method === 'login') {
          const minerInfo = miners.get(minerId);
          if (minerInfo) {
            if (message.params && message.params.login) {
              const loginParts = message.params.login.split('.');
              minerInfo.wallet = loginParts[0];
              minerInfo.workerName = loginParts.length > 1 ? loginParts[1] : 'default';
              minerInfo.workerKey = getWorkerKey(minerInfo.wallet, minerInfo.workerName);
              minerInfo.lastSeen = new Date().toISOString();
              minerInfo.nonceRange = allocateNonceRange();
              miners.set(minerId, minerInfo);
              
              const workerStat = getOrCreateWorkerStats(minerInfo.wallet, minerInfo.workerName);
              workerStat.activeConnections.add(minerId);
              workerStat.lastSeen = new Date().toISOString();
              workerStats.set(minerInfo.workerKey, workerStat);
              
              console.log(`[MINER] ${minerId} logged in: ${minerInfo.wallet}, worker: ${minerInfo.workerName}`);
              console.log(`[MINER] Nonce range: ${minerInfo.nonceRange.start_nonce} - ${minerInfo.nonceRange.end_nonce}`);
            }
            
            if (currentJob) {
              // Get a fresh computor index for this login
              const computorIndex = getNextComputorIndex();
              
              const loginResponse = {
                id: message.id,
                jsonrpc: "2.0",
                error: null,
                result: {
                  id: minerId,
                  status: "OK",
                  job: {
                    blob: currentJob.job.blob,
                    job_id: currentJob.job.job_id,
                    target: currentJob.job.target,
                    id: minerId,
                    seed_hash: currentJob.job.seed_hash,
                    height: currentJob.job.height,
                    algo: currentJob.job.algo || "rx/0",
                    computorIndex: computorIndex,
                    start_nonce: minerInfo.nonceRange.start_nonce,
                    end_nonce: minerInfo.nonceRange.end_nonce
                  }
                }
              };
              
              if (CONFIG.verbose) {
                console.log(`[MINER] Login response with computor index ${computorIndex}: ${JSON.stringify(loginResponse)}`);
              }
              
              socket.write(JSON.stringify(loginResponse) + '\n');
            } else {
              const basicLoginResponse = {
                id: message.id,
                jsonrpc: "2.0",
                error: null,
                result: {
                  id: minerId,
                  status: "OK"
                }
              };
              
              socket.write(JSON.stringify(basicLoginResponse) + '\n');
            }
          }
        }
        
        else if (message.method === 'keepalived' || message.method === 'keepalive') {
          const pongResponse = {
            id: message.id || 0,
            jsonrpc: "2.0",
            error: null,
            result: {
              status: "OK"
            }
          };
          
          socket.write(JSON.stringify(pongResponse) + '\n');
          
          if (CONFIG.verbose) {
            console.log(`[MINER] Sent keepalive response to ${minerId}`);
          }
        }
        
        else if (message.method === 'getjob') {
          const minerInfo = miners.get(minerId);
          if (minerInfo && currentJob) {
            minerInfo.nonceRange = allocateNonceRange();
            miners.set(minerId, minerInfo);
            
            // Get a fresh computor index for this job request
            const computorIndex = getNextComputorIndex();
            
            const jobResponse = {
              id: message.id,
              jsonrpc: "2.0",
              error: null,
              result: {
                blob: currentJob.job.blob,
                job_id: currentJob.job.job_id,
                target: currentJob.job.target,
                id: minerId,
                seed_hash: currentJob.job.seed_hash,
                height: currentJob.job.height,
                algo: currentJob.job.algo || "rx/0",
                computorIndex: computorIndex,
                start_nonce: minerInfo.nonceRange.start_nonce,
                end_nonce: minerInfo.nonceRange.end_nonce
              }
            };
            
            socket.write(JSON.stringify(jobResponse) + '\n');
            
            if (CONFIG.verbose) {
              console.log(`[MINER] Sent job to ${minerId} with computor index ${computorIndex}, nonce: ${minerInfo.nonceRange.start_nonce} - ${minerInfo.nonceRange.end_nonce}`);
            }
          } else {
            const emptyJobResponse = {
              id: message.id,
              jsonrpc: "2.0",
              error: null,
              result: { status: "NO_JOB" }
            };
            
            socket.write(JSON.stringify(emptyJobResponse) + '\n');
          }
        }
        
        else if (message.method === 'submit') {
          const minerInfo = miners.get(minerId);
          if (minerInfo && minerInfo.workerKey) {
            minerInfo.shares++;
            minerInfo.lastSeen = new Date().toISOString();
            miners.set(minerId, minerInfo);
            
            const workerStat = workerStats.get(minerInfo.workerKey);
            if (workerStat) {
              workerStat.shares++;
              workerStat.lastSeen = new Date().toISOString();
              
              workerStat.shareHistory.push(Date.now());
              
              const cutoffTime = Date.now() - CONFIG.hashrateWindow;
              workerStat.shareHistory = workerStat.shareHistory.filter(timestamp => timestamp >= cutoffTime);
              
              workerStats.set(minerInfo.workerKey, workerStat);
            }
            
            totalShares++;
            
            console.log(`[SHARE] Miner ${minerId} (${minerInfo.wallet}, Worker: ${minerInfo.workerName}) found a share! Total: ${workerStat ? workerStat.shares : minerInfo.shares}`);
            console.log(`[SHARE] *** SOLUTION FOUND FOR JOB: ${currentJob ? currentJob.job.job_id : 'Unknown'} ***`);
            
            const shareResponse = {
              id: message.id,
              jsonrpc: "2.0",
              error: null,
              result: {
                status: "OK"
              }
            };
            
            socket.write(JSON.stringify(shareResponse) + '\n');
            console.log(`[SHARE] Accepted from miner ${minerId}`);
            
            // Get computor index for this share
            const computorIndex = message.params.computorIndex || getNextComputorIndex();
            
            const simplifiedShareMessage = {
              params: {
                nonce: message.params.nonce,
                result: message.params.result
              },
              task_id: currentJob ? currentJob.id : null,
              task_seed_hash: currentJob && currentJob.job ? currentJob.job.seed_hash : null,
              computorIndex: computorIndex
            };
            
            distributeShare(simplifiedShareMessage);
          }
        }
        
        else {
          const defaultResponse = {
            id: message.id || 0,
            jsonrpc: "2.0",
            error: null,
            result: {
              status: "OK"
            }
          };
          
          socket.write(JSON.stringify(defaultResponse) + '\n');
          
          if (CONFIG.verbose) {
            console.log(`[MINER] Default response for ${message.method} to ${minerId}`);
          }
        }
      }
    } catch (error) {
      console.error(`[MINER] Error from ${minerId}:`, error);
    }
  });

  socket.on('end', () => {
    console.log(`[MINER] Disconnected: ${minerId}`);
    const minerInfo = miners.get(minerId);
    if (minerInfo) {
      minerInfo.connected = false;
      miners.set(minerId, minerInfo);
      
      if (minerInfo.workerKey) {
        const workerStat = workerStats.get(minerInfo.workerKey);
        if (workerStat) {
          workerStat.activeConnections.delete(minerId);
          workerStat.lastSeen = new Date().toISOString();
          workerStats.set(minerInfo.workerKey, workerStat);
        }
      }
    }
  });

  socket.on('error', (err) => {
    console.error(`[MINER] Socket error for ${minerId}:`, err);
  });
});

const shareClients = new Set();

const shareDistributionServer = net.createServer((socket) => {
  console.log(`[SHARE CLIENT] Connected: ${socket.remoteAddress}:${socket.remotePort}`);
  shareClients.add(socket);
  
  let clientBuffer = '';
  
  socket.on('data', (data) => {
    try {
      clientBuffer += data.toString();
      
      let messages = [];
      let start = 0;
      
      for (let i = 0; i < clientBuffer.length; i++) {
        if (clientBuffer[i] === '\n') {
          let line = clientBuffer.substring(start, i).trim();
          if (line) {
            try {
              let message = JSON.parse(line);
              messages.push(message);
            } catch (e) {
              console.error('[SHARE CLIENT] Parse error:', e);
            }
          }
          start = i + 1;
        }
      }
      
      clientBuffer = clientBuffer.substring(start);
      
      for (const message of messages) {
        if (CONFIG.verbose) {
          console.log(`[SHARE CLIENT] Received: ${JSON.stringify(message)}`);
        }
      }
    } catch (error) {
      console.error('[SHARE CLIENT] Error:', error);
    }
  });
  
  socket.on('end', () => {
    console.log(`[SHARE CLIENT] Disconnected: ${socket.remoteAddress}:${socket.remotePort}`);
    shareClients.delete(socket);
  });
  
  socket.on('error', (err) => {
    console.error(`[SHARE CLIENT] Error: ${err}`);
    shareClients.delete(socket);
  });
});

function distributeShare(message) {
  let distributedTo = 0;
  
  for (const client of shareClients) {
    if (client.writable) {
      client.write(JSON.stringify(message) + '\n');
      distributedTo++;
    }
  }
  
  if (CONFIG.verbose) {
    console.log(`[SHARE DISTRIBUTION] Sent to ${distributedTo} clients`);
    console.log(`[SHARE DISTRIBUTION] task_id: ${message.task_id}, hash: ${message.task_seed_hash}, computorIndex: ${message.computorIndex}`);
  }
  
  if (distributedTo === 0) {
    console.log('[SHARE DISTRIBUTION] Warning: No share clients connected');
  }
}

function broadcastToMiners() {
  let activeMiners = 0;
  
  if (!currentJob) {
    console.log("[JOB] No job to broadcast");
    return;
  }
  
  miners.forEach((minerInfo, minerId) => {
    if (minerInfo.connected && minerInfo.socket && minerInfo.socket.writable) {
      minerInfo.nonceRange = allocateNonceRange();
      miners.set(minerId, minerInfo);
      
      // Get a fresh computor index for broadcast
      const computorIndex = getNextComputorIndex();
      
      const minerJob = {
        jsonrpc: "2.0",
        method: "job",
        params: {
          blob: currentJob.job.blob,
          job_id: currentJob.job.job_id,
          target: currentJob.job.target,
          id: minerId,
          seed_hash: currentJob.job.seed_hash,
          height: currentJob.job.height,
          algo: currentJob.job.algo || "rx/0",
          computorIndex: computorIndex,
          start_nonce: minerInfo.nonceRange.start_nonce,
          end_nonce: minerInfo.nonceRange.end_nonce
        }
      };
      
      minerInfo.socket.write(JSON.stringify(minerJob) + '\n');
      activeMiners++;
      
      if (CONFIG.verbose) {
        console.log(`[JOB] Sent to miner ${minerId} with computor index ${computorIndex}, nonce: ${minerInfo.nonceRange.start_nonce} - ${minerInfo.nonceRange.end_nonce}`);
      }
    }
  });
  
  console.log(`[JOB] Sent to ${activeMiners} miners`);
}

function formatHashrate(hashrate) {
  if (hashrate === 0) return '0 H/s';
  
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  const i = Math.floor(Math.log(hashrate) / Math.log(1000));
  
  if (i >= units.length) return `${(hashrate / Math.pow(1000, units.length - 1)).toFixed(2)} ${units[units.length - 1]}`;
  
  return `${(hashrate / Math.pow(1000, i)).toFixed(2)} ${units[i]}`;
}

function generateStats() {
  const stats = {
    totalShares,
    lastShareReset,
    computorDistribution,
    currentEpoch,
    minerCount: {
      total: miners.size,
      active: Array.from(miners.values()).filter(m => m.connected).length
    },
    workers: [],
    currentTime: new Date().toISOString(),
    uptime: process.uptime()
  };
  
  let totalHashrate = 0;
  
  workerStats.forEach((workerStat, workerKey) => {
    const hashrate = calculateHashrate(workerStat.shareHistory);
    totalHashrate += hashrate;
    
    const isActive = workerStat.activeConnections.size > 0;
    
    stats.workers.push({
      workerKey,
      wallet: workerStat.wallet,
      workerName: workerStat.workerName,
      shares: workerStat.shares,
      active: isActive,
      lastSeen: workerStat.lastSeen,
      hashrate,
      hashrateFormatted: formatHashrate(hashrate)
    });
  });
  
  stats.workers.sort((a, b) => b.hashrate - a.hashrate);
  
  stats.totalHashrate = totalHashrate;
  stats.totalHashrateFormatted = formatHashrate(totalHashrate);
  
  return stats;
}

function saveStatsToFile() {
  const stats = generateStats();
  fs.writeFile(CONFIG.statsPath, JSON.stringify(stats, null, 2), (err) => {
    if (err) {
      console.error('[STATS] Error saving stats:', err);
    } else if (CONFIG.verbose) {
      console.log(`[STATS] Saved to ${CONFIG.statsPath}`);
    }
  });
}

function generateEnhancedHTML() {
    let htmlContent = fs.readFileSync(
        path.join(__dirname, "index.html"),
        "utf8"
    );
    return htmlContent;
}

const statsServer = http.createServer((req, res) => {
  // Enable CORS for all requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle OPTIONS preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // Add basic authentication for admin routes
  if (req.url.startsWith('/admin/')) {
    const authHeader = req.headers.authorization || '';
    
    if (!authHeader.startsWith('Basic ')) {
      res.writeHead(401, { 
        'Content-Type': 'text/plain',
        'WWW-Authenticate': 'Basic realm="Admin Access"'
      });
      res.end('Authentication required');
      return;
    }
    
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
    const [username, password] = credentials.split(':');
    
    if (password !== CONFIG.adminPassword) {
      res.writeHead(401, { 
        'Content-Type': 'text/plain',
        'WWW-Authenticate': 'Basic realm="Admin Access"'
      });
      res.end('Invalid credentials');
      return;
    }
    
    // Rewrite admin URLs to remove the /admin prefix for processing
    req.url = req.url.replace('/admin', '');
  }
  
  // Redirect root to admin interface
  if (req.url === '/') {
    res.writeHead(302, { 'Location': '/admin/computors' });
    res.end();
    return;
  }
  
  // Add endpoint to update computor weight
  if (req.url === '/update-computor-weight' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const index = parseInt(data.index);
        const weight = parseInt(data.weight);
        
        if (isNaN(index) || index < 0 || index >= computorDistribution.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid index' }));
          return;
        }
        
        if (isNaN(weight) || weight < 1 || weight > 100) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid weight' }));
          return;
        }
        
        // Update computor weight
        computorDistribution[index].weight = weight;
        saveComputorDistribution();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: `Updated computor index ${computorDistribution[index].index} weight to ${weight}%` 
        }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid request format' }));
      }
    });
  }
  // Re-route /computors to serve the admin UI
  else if (req.url === '/computors') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(generateEnhancedHTML());
  }
  
  else if (req.url === '/stats' || req.url === '/api/stats') {
    const stats = generateStats();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats, null, 2));
    
    if (CONFIG.verbose) {
      console.log(`[STATS] Served to ${req.socket.remoteAddress}`);
    }
  } 
  else if (req.url === '/computor-list') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(computorIdentities, null, 2));
  }
  else if (req.url === '/add-computor' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const newIndex = parseInt(data.index);
        const weight = parseInt(data.weight);
        const identity = data.identity || null;
        
        if (isNaN(newIndex) || newIndex < 0 || newIndex > 675) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid computor index' }));
          return;
        }
        
        if (isNaN(weight) || weight < 1 || weight > 100) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid weight' }));
          return;
        }
        
        // Check if index already exists
        const existingIndex = computorDistribution.findIndex(item => item.index === newIndex);
        if (existingIndex !== -1) {
          // Update existing entry
          computorDistribution[existingIndex].weight = weight;
          if (identity) {
            computorDistribution[existingIndex].identity = identity;
          }
        } else {
          // Add new entry
          computorDistribution.push({
            index: newIndex,
            weight: weight,
            identity: identity
          });
        }
        
        saveComputorDistribution();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: `Computor index ${newIndex} added with weight ${weight}%` 
        }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid request format' }));
      }
    });
  }
  else if (req.url === '/remove-computor' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const indexToRemove = parseInt(data.index);
        
        if (isNaN(indexToRemove) || indexToRemove < 0 || indexToRemove >= computorDistribution.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid index' }));
          return;
        }
        
        computorDistribution.splice(indexToRemove, 1);
        
        saveComputorDistribution();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: 'Computor removed successfully' 
        }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid request format' }));
      }
    });
  }
  else if (req.url === '/add-identity-batch' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const identities = data.identities;
        const weight = parseInt(data.weight);
        
        if (!Array.isArray(identities) || identities.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid identities' }));
          return;
        }
        
        if (isNaN(weight) || weight < 1 || weight > 100) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid weight' }));
          return;
        }
        
        let added = 0;
        let notFound = [];
        
        for (const identity of identities) {
          const index = findComputorIndex(identity);
          
          if (index !== -1) {
            // Check if index already exists in distribution
            const existingIndex = computorDistribution.findIndex(item => item.index === index);
            if (existingIndex !== -1) {
              // Update existing entry
              computorDistribution[existingIndex].weight = weight;
              computorDistribution[existingIndex].identity = identity;
            } else {
              // Add new entry
              computorDistribution.push({
                index: index,
                weight: weight,
                identity: identity
              });
            }
            added++;
          } else {
            notFound.push(identity);
          }
        }
        
        saveComputorDistribution();
        
        let message = `Added ${added} identities with weight ${weight}%.`;
        if (notFound.length > 0) {
          message += ` ${notFound.length} identities not found in current epoch.`;
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: message,
          notFound: notFound
        }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid request format: ' + error.message }));
      }
    });
  }
  else if (req.url === '/fetch-computor-list' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const epoch = parseInt(data.epoch);
        
        if (isNaN(epoch) || epoch < 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid epoch number' }));
          return;
        }
        
        fetchComputorList(epoch, (error, identities) => {
          if (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: false, 
              message: `Failed to fetch computor list: ${error.message}` 
            }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: true, 
              message: `Retrieved ${identities.length} computors for epoch ${epoch}`,
              identities: identities
            }));
          }
        });
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid request format' }));
      }
    });
  }
  else if (req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(generateEnhancedHTML());
  }
  else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// Startup
console.log('[STARTUP] Loading statistics...');
loadPersistentStats();

console.log('[STARTUP] Loading computor settings...');
loadComputorSettings();

console.log('[STARTUP] Initializing nonce...');
initializeNonce();

console.log('[STARTUP] Connecting to task source...');
connectToTaskSource();

// Start servers
minerServer.listen(CONFIG.minerPort, '0.0.0.0', () => {
  console.log(`[STARTUP] Miner server on 0.0.0.0:${CONFIG.minerPort}`);
});

shareDistributionServer.listen(CONFIG.shareDistributionPort, '0.0.0.0', () => {
  console.log(`[STARTUP] Share distribution on 0.0.0.0:${CONFIG.shareDistributionPort}`);
});

statsServer.listen(CONFIG.statsPort, '0.0.0.0', () => {
  console.log(`[STARTUP] HTTP server on 0.0.0.0:${CONFIG.statsPort}`);
  console.log(`[STARTUP] Admin UI available at http://localhost:${CONFIG.statsPort}/admin/computors`);
});

// Start intervals
setInterval(sendKeepaliveToMiners, CONFIG.keepaliveInterval);
setInterval(saveStatsToFile, CONFIG.statsInterval);
setInterval(savePersistentStats, CONFIG.persistentStatsInterval);
setInterval(checkAndResetShares, 60000);

// Get initial computor list if none exists
if (computorIdentities.length === 0) {
  console.log(`[API] Fetching initial computor list for epoch ${currentEpoch}...`);
  fetchComputorList(currentEpoch, (error, identities) => {
    if (error) {
      console.error(`[API] Error fetching initial computor list: ${error.message}`);
    } else {
      console.log(`[API] Initial computor list loaded with ${identities.length} identities`);
    }
  });
}

// Log stats periodically
setInterval(() => {
  const stats = generateStats();
  
  console.log('--- Mining Stats ---');
  console.log(`Shares: ${stats.totalShares}`);
  console.log(`Hashrate: ${stats.totalHashrateFormatted}`);
  console.log(`Miners: ${stats.minerCount.active}/${stats.minerCount.total}`);
  console.log(`Computors: ${stats.computorDistribution.length}`);
  console.log(`Last Reset: ${new Date(lastShareReset).toLocaleString()} (UTC)`);
  
  const activeWorkers = stats.workers.filter(w => w.active && w.shares > 0);
  if (activeWorkers.length > 0) {
    console.log('Active Workers:');
    activeWorkers.forEach(worker => {
      console.log(`  ${worker.workerKey}: ${worker.shares} shares, ${worker.hashrateFormatted}`);
    });
  } else {
    console.log('  No active workers with shares');
  }
  
  console.log('-----------------');
}, CONFIG.statsInterval);

// Check for inactive miners
setInterval(() => {
  const now = Date.now();
  miners.forEach((minerInfo, minerId) => {
    if (minerInfo.connected && (now - minerInfo.lastActivity) > CONFIG.keepaliveTimeout) {
      console.log(`[MINER] Disconnecting inactive ${minerId} (inactive for ${(now - minerInfo.lastActivity) / 1000}s)`);
      if (minerInfo.socket) {
        minerInfo.socket.end();
      }
      minerInfo.connected = false;
      miners.set(minerId, minerInfo);
      
      if (minerInfo.workerKey) {
        const workerStat = workerStats.get(minerInfo.workerKey);
        if (workerStat) {
          workerStat.activeConnections.delete(minerId);
          workerStat.lastSeen = new Date().toISOString();
          workerStats.set(minerInfo.workerKey, workerStat);
        }
      }
    }
  });
}, 30000);

// Prune old share history entries
setInterval(() => {
  const cutoffTime = Date.now() - CONFIG.hashrateWindow;
  
  workerStats.forEach((workerStat, workerKey) => {
    workerStat.shareHistory = workerStat.shareHistory.filter(timestamp => timestamp >= cutoffTime);
    workerStats.set(workerKey, workerStat);
  });
  
  if (CONFIG.verbose) {
    console.log('[MAINTENANCE] Pruned old share history entries');
  }
}, 60000);

// Handle process events
process.on('uncaughtException', (err) => {
  console.error('[ERROR] Uncaught exception:', err);
});

process.on('SIGINT', () => {
  console.log('[SHUTDOWN] Shutting down...');
  process.exit(0);
});

// Health check
setInterval(() => {
  if (miners.size === 0 && shareClients.size === 0) {
    console.log('[HEALTH] Waiting for connections...');
    console.log('[HEALTH] Miner port:', CONFIG.minerPort);
    console.log('[HEALTH] Dashboard port:', CONFIG.statsPort);
    console.log('[HEALTH] Computors:', computorDistribution.length);
  }
}, 60000);
