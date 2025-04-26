const net = require('net');
const http = require('http');
const fs = require('fs');

// Edit these values as needed
const CONFIG = {
  // Connection settings
  taskSourceHost: 'localhost',
  taskSourcePort: 8765,
  minerPort: 3333,
  shareDistributionPort: 8766,
  statsPort: 8088,
  
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
  defaultComputorIndex: 0,
  nonceRangeSize: 155480000, // Size for a 7950X CPU
  computorSettingsPath: './computor_settings.json'
};

// Global state
const miners = new Map();
const workerStats = new Map();
let totalShares = 0;
let lastShareReset = null;
let currentJob = null;
let lastJobId = null;
let currentComputorIndex = CONFIG.defaultComputorIndex;
let nextNonceStartValue = 0;

function initializeNonce() {
  nextNonceStartValue = Math.floor(Math.random() * 2147483648);
  console.log(`[NONCE] Initialized next nonce start value to ${nextNonceStartValue}`);
}

function loadComputorSettings() {
  try {
    if (fs.existsSync(CONFIG.computorSettingsPath)) {
      const data = fs.readFileSync(CONFIG.computorSettingsPath, 'utf8');
      const settings = JSON.parse(data);
      
      if (typeof settings.computorIndex === 'number') {
        currentComputorIndex = settings.computorIndex;
        console.log(`[SETTINGS] Loaded computor index: ${currentComputorIndex}`);
      }
    } else {
      console.log(`[SETTINGS] No settings file found, using default index: ${currentComputorIndex}`);
    }
  } catch (error) {
    console.error('[SETTINGS] Error loading settings:', error);
    console.log(`[SETTINGS] Using default index: ${currentComputorIndex}`);
  }
}

function saveComputorSettings() {
  const settings = {
    computorIndex: currentComputorIndex,
    savedAt: new Date().toISOString()
  };
  
  fs.writeFile(CONFIG.computorSettingsPath, JSON.stringify(settings, null, 2), (err) => {
    if (err) {
      console.error('[SETTINGS] Error saving settings:', err);
    } else if (CONFIG.verbose) {
      console.log(`[SETTINGS] Settings saved`);
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
          
          currentJob.job.computorIndex = currentComputorIndex;
          
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
                    computorIndex: currentComputorIndex,
                    start_nonce: minerInfo.nonceRange.start_nonce,
                    end_nonce: minerInfo.nonceRange.end_nonce
                  }
                }
              };
              
              if (CONFIG.verbose) {
                console.log(`[MINER] Login response: ${JSON.stringify(loginResponse)}`);
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
                computorIndex: currentComputorIndex,
                start_nonce: minerInfo.nonceRange.start_nonce,
                end_nonce: minerInfo.nonceRange.end_nonce
              }
            };
            
            socket.write(JSON.stringify(jobResponse) + '\n');
            
            if (CONFIG.verbose) {
              console.log(`[MINER] Sent job to ${minerId}, nonce: ${minerInfo.nonceRange.start_nonce} - ${minerInfo.nonceRange.end_nonce}`);
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
            
            const simplifiedShareMessage = {
              params: {
                nonce: message.params.nonce,
                result: message.params.result
              },
              task_id: currentJob ? currentJob.id : null,
              task_seed_hash: currentJob && currentJob.job ? currentJob.job.seed_hash : null,
              computorIndex: currentComputorIndex
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
          computorIndex: currentComputorIndex,
          start_nonce: minerInfo.nonceRange.start_nonce,
          end_nonce: minerInfo.nonceRange.end_nonce
        }
      };
      
      minerInfo.socket.write(JSON.stringify(minerJob) + '\n');
      activeMiners++;
      
      if (CONFIG.verbose) {
        console.log(`[JOB] Sent to miner ${minerId}, nonce: ${minerInfo.nonceRange.start_nonce} - ${minerInfo.nonceRange.end_nonce}`);
      }
    }
  });
  
  console.log(`[JOB] Sent to ${activeMiners} miners (Computor: ${currentComputorIndex})`);
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
    currentComputorIndex,
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

function generateComputorSettingsHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QUBIC <--> XMR Proxy Settings</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background: #f7f7f7;
    }
    h1, h2 {
      color: #2c3e50;
    }
    .card {
      background: white;
      border-radius: 5px;
      padding: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 5px;
      font-weight: bold;
    }
    input[type="number"] {
      width: 100%;
      padding: 8px;
      margin-bottom: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 16px;
    }
    button {
      background-color: #3498db;
      color: white;
      border: none;
      padding: 10px 15px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 16px;
    }
    button:hover {
      background-color: #2980b9;
    }
    .info {
      background-color: #e7f5fe;
      padding: 15px;
      border-left: 4px solid #3498db;
      margin-bottom: 20px;
    }
    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .stat-box {
      background: #f9f9f9;
      padding: 15px;
      border-radius: 4px;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.05);
    }
    .stat-value {
      font-size: 20px;
      font-weight: bold;
      color: #2c3e50;
    }
    .stat-label {
      color: #7f8c8d;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <h1>QUBIC <--> XMR Proxy Settings</h1>
  
  <div class="info">
    This interface allows you to configure which Qubic computor index to mine for. 
    Changes will apply to all new jobs received.
  </div>
  
  <div class="card">
    <h2>Computor Index Configuration</h2>
    <label for="computorIndex">Computor Index:</label>
    <input type="number" id="computorIndex" value="${currentComputorIndex}" min="0" max="676">
    <button onclick="updateComputorIndex()">Update</button>
    <p id="result"></p>
  </div>
  
  <div class="card">
    <h2>Mining Statistics</h2>
    <div class="stats">
      <div class="stat-box">
        <div class="stat-value" id="totalShares">-</div>
        <div class="stat-label">Total Shares</div>
      </div>
      <div class="stat-box">
        <div class="stat-value" id="activeMiners">-</div>
        <div class="stat-label">Active Miners</div>
      </div>
      <div class="stat-box">
        <div class="stat-value" id="totalHashrate">-</div>
        <div class="stat-label">Total Hashrate</div>
      </div>
      <div class="stat-box">
        <div class="stat-value" id="uptime">-</div>
        <div class="stat-label">Uptime</div>
      </div>
    </div>
  </div>
  
  <script>
    // Update computor index
    function updateComputorIndex() {
      const computorIndex = parseInt(document.getElementById('computorIndex').value);
      
      if (isNaN(computorIndex) || computorIndex < 0 || computorIndex > 676) {
        document.getElementById('result').textContent = 'Invalid computor index! Must be between 0 and 676.';
        return;
      }
      
      fetch('/update-computor-index', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ computorIndex }),
      })
      .then(response => response.json())
      .then(data => {
        document.getElementById('result').textContent = data.message;
        loadStats();
      })
      .catch(error => {
        document.getElementById('result').textContent = 'Error: ' + error.message;
      });
    }
    
    // Format time duration (seconds to days, hours, minutes, seconds)
    function formatDuration(seconds) {
      const days = Math.floor(seconds / 86400);
      seconds %= 86400;
      const hours = Math.floor(seconds / 3600);
      seconds %= 3600;
      const minutes = Math.floor(seconds / 60);
      seconds = Math.floor(seconds % 60);
      
      const parts = [];
      if (days > 0) parts.push(days + 'd');
      if (hours > 0) parts.push(hours + 'h');
      if (minutes > 0) parts.push(minutes + 'm');
      if (seconds > 0 || parts.length === 0) parts.push(seconds + 's');
      
      return parts.join(' ');
    }
    
    // Load mining statistics
    function loadStats() {
      fetch('/stats')
        .then(response => response.json())
        .then(data => {
          document.getElementById('totalShares').textContent = data.totalShares;
          document.getElementById('activeMiners').textContent = data.minerCount.active;
          document.getElementById('totalHashrate').textContent = data.totalHashrateFormatted;
          document.getElementById('uptime').textContent = formatDuration(data.uptime);
          
          document.getElementById('computorIndex').value = data.currentComputorIndex;
        })
        .catch(error => {
          console.error('Error loading stats:', error);
        });
    }
    
    // Load stats on page load and every 10 seconds
    loadStats();
    setInterval(loadStats, 10000);
  </script>
</body>
</html>
  `;
}

const statsServer = http.createServer((req, res) => {
  if (req.url === '/stats' || req.url === '/api/stats') {
    const stats = generateStats();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats, null, 2));
    
    if (CONFIG.verbose) {
      console.log(`[STATS] Served to ${req.socket.remoteAddress}`);
    }
  } 
  else if (req.url === '/update-computor-index' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const newComputorIndex = parseInt(data.computorIndex);
        
        if (isNaN(newComputorIndex) || newComputorIndex < 0 || newComputorIndex > 676) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid computor index' }));
          return;
        }
        
        const oldIndex = currentComputorIndex;
        currentComputorIndex = newComputorIndex;
        
        saveComputorSettings();
        
        console.log(`[SETTINGS] Computor index changed from ${oldIndex} to ${currentComputorIndex}`);
        
        if (currentJob) {
          currentJob.job.computorIndex = currentComputorIndex;
          broadcastToMiners();
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: `Computor index updated to ${currentComputorIndex}. Miners will receive the new job on next request.` 
        }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid request format' }));
      }
    });
  }
  else if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(generateComputorSettingsHTML());
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
  console.log(`[STARTUP] UI available at http://localhost:${CONFIG.statsPort}/`);
});

// Start intervals
setInterval(sendKeepaliveToMiners, CONFIG.keepaliveInterval);
setInterval(saveStatsToFile, CONFIG.statsInterval);
setInterval(savePersistentStats, CONFIG.persistentStatsInterval);
setInterval(checkAndResetShares, 60000);

// Log stats periodically
setInterval(() => {
  const stats = generateStats();
  
  console.log('--- Mining Stats ---');
  console.log(`Shares: ${stats.totalShares}`);
  console.log(`Hashrate: ${stats.totalHashrateFormatted}`);
  console.log(`Miners: ${stats.minerCount.active}/${stats.minerCount.total}`);
  console.log(`Computor: ${stats.currentComputorIndex}`);
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
    console.log('[HEALTH] Computor index:', currentComputorIndex);
  }
}, 60000);
