const net = require('net');
const http = require('http');
const fs = require('fs').promises;
const fsSync = require('fs');
const https = require('https');
const path = require('path');
const EventEmitter = require('events');

// Constants for the new nonce calculation
const DOMAIN_SIZE = 25414007; // Fixed domain size per computor

// Edit these values as needed
const CONFIG = {
  // Connection settings
  taskSourceHost: 'localhost',
  taskSourcePort: 8765,
  minerPort: 3333,
  shareDistributionPort: 8766,
  statsPort: 8088,
  
  // Admin authentication
  adminPassword: 'SecurePasswrd', // Change this to your preferred password
  
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
  
  // Reset schedule (Wednesday at 12PM UTC NEW QUBIC EPOCH) TO FIX 
  resetDay: 3,
  resetHour: 12,
  resetMinute: 0,
  
  computorSettingsPath: './computor_settings.json',
  computorIndexesPath: './computor_indexes.json',
  computorAssignmentsPath: './computor_assignments.json',
  
  defaultEpoch: 160,
  rpcEndpoint: 'rpc.qubic.org',
  
  // Connection management
  maxConnectionsPerIP: 10000, // DANGEROUS ADAPT TO YOUR VALUE
  connectionRateLimit: 10000, // DANGEROUS ADAPT TO YOUR VALUE
  connectionRateWindow: 60000, // 1 minute measurement only
  loginTimeout: 60000, // 60 seconds for login (30s recommended)
  bufferLimit: 1024 * 1024 * 1024, // 1GB FOR TESTING!! PRODUCTION USE 5MB (5 * 1024 * 1024)
  
  // Logging options
  logStatInterval: 300000, // Log stats every 5 minutes
  logHealthInterval: 300000, // Log health checks every 5 minutes
  logKeepalive: false, // Don't log keepalive messages
  logDetailedMinerEvents: false, // Don't log detailed miner events
  
  // Circuit breaker settings
  circuitBreakerThreshold: 10, // failures
  circuitBreakerResetTimeout: 30000, // 30 seconds
  
  // Performance settings
  aliasTableRefreshInterval: 300000, // 5 minutes
  maxRecentJobs: 5, // Keep track of last 5 jobs
  pruneShareHistoryInterval: 30000 // 30 seconds
};

// Global state managed by StateManager
class StateManager extends EventEmitter {
  constructor() {
    super();
    this.miners = new Map();
    this.workerStats = new Map();
    this.minerComputorAssignments = new Map();
    this.totalShares = 0;
    this.lastShareReset = null;
    this.currentJob = null;
    this.lastJobId = null;
    
    // Multi-computor state
    this.computorDistribution = []; // Array of {index, weight, identity}
    this.computorIdentities = []; // Array of identities from the API
    this.currentEpoch = CONFIG.defaultEpoch;
    
    // Nonce tracking state
    this.nonceRanges = []; // Array of {start, end, jobId} - sorted by start
    this.recentJobs = new Map(); // Cache of recent jobs
    
    // Optimization: Add cache for computors by range
    this.validComputorsCache = new Map(); // Cache for valid computors per range
    
    // Group 1: 0-168, Group 2: 169-337, Group 3: 338-506, Group 4: 507-675
    
    // Alias method table for weighted random
    this.aliasTable = [];
    this.aliasNeedsRefresh = true;
    
    // Circuit breaker state
    this.circuitBreakers = new Map();
    
    // Connection rate tracking
    this.connectionRates = new Map(); // IP -> [timestamps]
    
    // Statistics tracking for task processing
    this.taskStats = {
      processed: 0,
      skipped: 0,
      mined: 0,
      lastProcessed: null,
      processingTimes: [], // Last 100 processing times in ms
      byGroup: [0, 0, 0, 0] // Tasks mined per group
    };
    
    // Worker group tracking for minimizing switching
    this.workerGroupAssignments = new Map(); // Map of workerKey to preferred group
    this.lastGroupTask = new Map(); // Map of group ID to last task
    
    this.groupSwitchCooldown = 60000; // 60 seconds cooldown between group switches (INCREASE IF TOO MANY SWITCHING)
    
    // Event channel for cross-component communication
    this.initEventHandlers();
  }
  
  initEventHandlers() {
    this.on('job', (job) => {
      this.currentJob = job;
      this.lastJobId = job.job.job_id;
      
      // Store the job in recent jobs cache (using a proper clone)
      this.storeRecentJob(job);
      
      // Clean up nonce ranges and invalid computor assignments
      this.cleanupInvalidComputorAssignments(
        job.job.first_computor_index,
        job.job.last_computor_index
      );
      
      // Determine which group this job belongs to
      let groupId = 0;
      if (job.job.first_computor_index >= 0 && job.job.first_computor_index <= 168) groupId = 1;
      else if (job.job.first_computor_index >= 169 && job.job.first_computor_index <= 337) groupId = 2;
      else if (job.job.first_computor_index >= 338 && job.job.first_computor_index <= 506) groupId = 3;
      else if (job.job.first_computor_index >= 507 && job.job.first_computor_index <= 675) groupId = 4;
      
      logger('job', `Processing job for group ${groupId} with ${this.miners.size} miners`);
      
      this.emit('broadcastJob', job);
    });
    
    this.on('share', (share) => {
      this.totalShares++;
      this.emit('distributionShare', share);
    });
    
    // Refresh the alias table when the computor distribution changes
    this.on('computorDistributionChanged', () => {
      this.aliasNeedsRefresh = true;
      
      // Clear cache when distribution changes
      if (this.validComputorsCache) {
        this.validComputorsCache.clear();
      }
      
      // Update computor distribution analysis
      this.analyzeComputorDistribution();
      
      logger('info', 'Computor distribution changed, refreshed caches');
    });
  }
  
  storeRecentJob(job) {
    // If job already exists, don't recreate it
    if (this.recentJobs.has(job.job.job_id)) {
      return;
    }
    
    // Store a copy of the job (efficient cloning)
    const newJob = {
      job: {
        job_id: job.job.job_id,
        blob: job.job.blob,
        target: job.job.target,
        seed_hash: job.job.seed_hash,
        height: job.job.height,
        algo: job.job.algo,
        first_computor_index: job.job.first_computor_index || 0,
        last_computor_index: job.job.last_computor_index || 675
      },
      method: job.method,
      id: job.id
    };
    
    this.recentJobs.set(job.job.job_id, newJob);
    
    // Precompute which computors are valid for this job and cache
    if (!this.validComputorsCache) {
      this.validComputorsCache = new Map();
    }
    
    const rangeKey = `${job.job.first_computor_index}-${job.job.last_computor_index}`;
    if (!this.validComputorsCache.has(rangeKey)) {
      const validComputors = this.computorDistribution.filter(
        item => item.index >= job.job.first_computor_index && 
               item.index <= job.job.last_computor_index
      );
      this.validComputorsCache.set(rangeKey, validComputors);
    }
    
    // If we have too many recent jobs, remove the oldest one
    if (this.recentJobs.size > CONFIG.maxRecentJobs) {
      // Use keys iterator to get oldest item efficiently
      const oldestJobId = Array.from(this.recentJobs.keys())[0];
      this.recentJobs.delete(oldestJobId);
      
      // Also clean up nonce ranges for old jobs
      this.cleanupOldJobMappings();
    }
  }
  
  cleanupOldJobMappings() {
    const validJobIds = new Set(this.recentJobs.keys());
    this.nonceRanges = this.nonceRanges.filter(range => validJobIds.has(range.jobId));
  }
  
  addNonceRange(start, end, jobId, computorIndex) {
    this.nonceRanges.push({start, end, jobId, computorIndex});
    // Keep ranges sorted by start value for binary search efficiency
    this.nonceRanges.sort((a, b) => a.start - b.start);
  }
  
  findJobForNonce(nonce) {
    // Binary search for the range containing the nonce - O(log n)
    let left = 0;
    let right = this.nonceRanges.length - 1;
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const range = this.nonceRanges[mid];
      
      if (nonce < range.start) {
        right = mid - 1;
      } else if (nonce > range.end) {
        left = mid + 1;
      } else {
        return { jobId: range.jobId, computorIndex: range.computorIndex };
      }
    }
    
    return null; // Not found in any range
  }
  
  cleanupInvalidComputorAssignments(firstComputorIndex, lastComputorIndex) {
    let removedCount = 0;
    
    // Create a list of entries to remove
    const toRemove = [];
    
    for (const [workerKey, computorIndex] of this.minerComputorAssignments.entries()) {
      if (computorIndex < firstComputorIndex || computorIndex > lastComputorIndex) {
        toRemove.push(workerKey);
      }
    }
    
    // Remove invalid entries
    for (const workerKey of toRemove) {
      this.minerComputorAssignments.delete(workerKey);
      removedCount++;
    }
    
    if (removedCount > 0) {
      logger('info', `Removed ${removedCount} computor assignments outside of valid range ${firstComputorIndex}-${lastComputorIndex}`);
    }
    
    return removedCount;
  }
  
  isRateLimited(ip) {
    if (!this.connectionRates.has(ip)) {
      this.connectionRates.set(ip, []);
    }
    
    const timestamps = this.connectionRates.get(ip);
    const now = Date.now();
    
    // Remove old timestamps
    while (timestamps.length > 0 && timestamps[0] < now - CONFIG.connectionRateWindow) {
      timestamps.shift();
    }
    
    // Check if rate limit exceeded
    if (timestamps.length >= CONFIG.connectionRateLimit) {
      return true;
    }
    
    // Add timestamp for this connection
    timestamps.push(now);
    return false;
  }
  
  prepareAliasTable(computors) {
    // Skip if no computors or only one (no need for weighted selection)
    if (!computors || computors.length <= 1) {
      this.aliasTable = computors || [];
      this.aliasNeedsRefresh = false;
      return;
    }
    
    // Implementation of Vose's alias method for O(1) weighted random selection
    const n = computors.length;
    const probabilities = new Array(n);
    const aliases = new Array(n);
    
    // Calculate scaled probabilities
    const totalWeight = computors.reduce((sum, c) => sum + c.weight, 0);
    const scaled = computors.map(c => (c.weight * n) / totalWeight);
    
    // Initialize work queues
    const small = [];
    const large = [];
    
    // Sort into small and large
    for (let i = 0; i < n; i++) {
      if (scaled[i] < 1) small.push(i);
      else large.push(i);
    }
    
    // Create alias pairs
    while (small.length > 0 && large.length > 0) {
      const s = small.pop();
      const l = large.pop();
      
      probabilities[s] = scaled[s];
      aliases[s] = l;
      
      scaled[l] = (scaled[l] + scaled[s]) - 1;
      if (scaled[l] < 1) small.push(l);
      else large.push(l);
    }
    
    // Handle remaining elements
    while (large.length > 0) {
      probabilities[large.pop()] = 1;
    }
    
    while (small.length > 0) {
      probabilities[small.pop()] = 1;
    }
    
    // Store computed table
    this.aliasTable = computors.map((c, i) => ({
      index: c.index,
      probability: probabilities[i],
      alias: aliases[i] !== undefined ? computors[aliases[i]].index : c.index
    }));
    
    this.aliasNeedsRefresh = false;
    logger('debug', `Prepared alias table for ${n} computors`);
  }
  
  weightedRandomSelect(computors) {
    if (!computors || computors.length === 0) return null;
    if (computors.length === 1) return computors[0].index;
    
    // Refresh alias table if needed
    if (this.aliasNeedsRefresh) {
      this.prepareAliasTable(computors);
    }
    
    // Random selection in O(1) time
    const i = Math.floor(Math.random() * this.aliasTable.length);
    return Math.random() < this.aliasTable[i].probability 
      ? this.aliasTable[i].index 
      : this.aliasTable[i].alias;
  }
  
  getNextComputorIndex(firstComputorIndex, lastComputorIndex, workerKey = null) {
    if (this.computorDistribution.length === 0) {
      logger('warn', `No computors configured, cannot select a computor index`);
      return null;
    }
    
    // Determine which group this task belongs to
    let taskGroup = 0;
    if (firstComputorIndex >= 0 && firstComputorIndex <= 168) taskGroup = 1;
    else if (firstComputorIndex >= 169 && firstComputorIndex <= 337) taskGroup = 2;
    else if (firstComputorIndex >= 338 && firstComputorIndex <= 506) taskGroup = 3;
    else if (firstComputorIndex >= 507 && firstComputorIndex <= 675) taskGroup = 4;
    
    // Optimization: Cache valid computors for frequently used ranges
    const rangeKey = `${firstComputorIndex}-${lastComputorIndex}`;
    if (!this.validComputorsCache) {
      this.validComputorsCache = new Map();
    }
    
    // Use cached computors for this range if available
    let validComputors;
    if (this.validComputorsCache.has(rangeKey)) {
      validComputors = this.validComputorsCache.get(rangeKey);
    } else {
      // Filter to valid computors in range
      validComputors = this.computorDistribution.filter(
        item => item.index >= firstComputorIndex && item.index <= lastComputorIndex
      );
      
      // Cache for future use (with a reasonable limit on cache size)
      if (this.validComputorsCache.size > 10) {
        // Remove oldest entry if cache is too large
        const oldestKey = this.validComputorsCache.keys().next().value;
        this.validComputorsCache.delete(oldestKey);
      }
      this.validComputorsCache.set(rangeKey, validComputors);
    }
    
    if (validComputors.length === 0) {
      logger('warn', `No configured computors within range ${firstComputorIndex}-${lastComputorIndex}, skipping job`);
      return null;
    }
    
    // For worker-specific assignments
    if (workerKey) {
      // Check if worker has a valid existing assignment
      if (this.minerComputorAssignments.has(workerKey)) {
        const currentAssignment = this.minerComputorAssignments.get(workerKey);
        if (currentAssignment >= firstComputorIndex && currentAssignment <= lastComputorIndex) {
          // Check if this computor is in our valid list
          if (validComputors.some(comp => comp.index === currentAssignment)) {
            return currentAssignment;
          }
        }
      }
      
      // Check if worker has a preferred group
      if (this.workerGroupAssignments.has(workerKey)) {
        const preferredGroup = this.workerGroupAssignments.get(workerKey);
        const lastGroupSwitchTime = this.workerGroupAssignments.get(`${workerKey}_switchTime`) || 0;
        const timeSinceSwitch = Date.now() - lastGroupSwitchTime;
        
        // If this task isn't from the worker's preferred group, enforce stricter rules
        if (preferredGroup !== taskGroup && preferredGroup !== 0) {
          // Only allow switching if the cooldown period has expired
          if (timeSinceSwitch < this.groupSwitchCooldown) {
            logger('debug', `Worker ${workerKey} strictly assigned to group ${preferredGroup}, rejecting task from group ${taskGroup} (cooldown: ${Math.round(timeSinceSwitch/1000)}s / ${Math.round(this.groupSwitchCooldown/1000)}s)`);
            return null; // Skip this task entirely
          } else {
            // Cooldown expired, allow group switch with logging
            logger('info', `Worker ${workerKey} switching from group ${preferredGroup} to ${taskGroup} after ${Math.round(timeSinceSwitch/1000)}s cooldown`);
            this.workerGroupAssignments.set(workerKey, taskGroup);
            this.workerGroupAssignments.set(`${workerKey}_switchTime`, Date.now());
          }
        }
      } else {
        // First assignment for this worker
        this.workerGroupAssignments.set(workerKey, taskGroup);
        this.workerGroupAssignments.set(`${workerKey}_switchTime`, Date.now());
      }
      
      // Get count of current assignments per computor
      const assignmentCounts = new Map();
      for (const [, computorIndex] of this.minerComputorAssignments) {
        if (computorIndex >= firstComputorIndex && computorIndex <= lastComputorIndex) {
          assignmentCounts.set(computorIndex, (assignmentCounts.get(computorIndex) || 0) + 1);
        }
      }
      
      // Calculate an assignment score for each computor
      // Lower scores are better: combines (1) current load and (2) reciprocal of weight
      const scoredComputors = validComputors.map(comp => {
        const currentCount = assignmentCounts.get(comp.index) || 0;
        const weightFactor = 100 / comp.weight; // Higher weight = lower factor
        return {
          index: comp.index,
          score: currentCount * 3 + weightFactor // Prioritize load balancing over weight
        };
      });
      
      // Sort by score (ascending - lower is better)
      scoredComputors.sort((a, b) => a.score - b.score);
      
      // Select best option
      const selectedIndex = scoredComputors[0].index;
      this.minerComputorAssignments.set(workerKey, selectedIndex);
      
      // Update task stats by group
      if (taskGroup > 0 && taskGroup <= 4 && this.taskStats && this.taskStats.byGroup) {
        this.taskStats.byGroup[taskGroup - 1]++;
      }
      
      return selectedIndex;
    }
    
    // For non-worker-specific selection, use O(1) alias method for weighted random
    return this.weightedRandomSelect(validComputors);
  }
  
  allocateNonceRange(jobId, computorIndex, firstComputorIndex, lastComputorIndex) {
    // Calculate nonce range based on the fixed domain size
    const start_nonce = (computorIndex - firstComputorIndex) * DOMAIN_SIZE;
    const end_nonce = start_nonce + DOMAIN_SIZE - 1;
    
    // Store the nonce range mapping
    this.addNonceRange(start_nonce, end_nonce, jobId, computorIndex);
    
    logger('debug', `Allocated range ${start_nonce}-${end_nonce} for job ${jobId}, computor ${computorIndex}`);
    
    return { start_nonce, end_nonce, computorIndex };
  }
  
  // Circuit breaker implementation
  getCircuitBreaker(service) {
    if (!this.circuitBreakers.has(service)) {
      this.circuitBreakers.set(service, {
        failures: 0,
        lastFailure: 0,
        state: 'CLOSED' // CLOSED, OPEN, HALF_OPEN TCP ONLY
      });
    }
    return this.circuitBreakers.get(service);
  }
  
  recordFailure(service) {
    const breaker = this.getCircuitBreaker(service);
    breaker.failures++;
    breaker.lastFailure = Date.now();
    
    if (breaker.failures >= CONFIG.circuitBreakerThreshold) {
      breaker.state = 'OPEN';
      logger('warn', `Circuit breaker OPEN for service: ${service}`);
      
      // Schedule reset to half-open
      setTimeout(() => {
        if (breaker.state === 'OPEN') {
          breaker.state = 'HALF_OPEN';
          logger('info', `Circuit breaker HALF_OPEN for service: ${service}`);
        }
      }, CONFIG.circuitBreakerResetTimeout);
    }
  }
  
  recordSuccess(service) {
    const breaker = this.getCircuitBreaker(service);
    if (breaker.state === 'HALF_OPEN') {
      breaker.state = 'CLOSED';
      breaker.failures = 0;
      logger('info', `Circuit breaker CLOSED for service: ${service}`);
    } else if (breaker.state === 'CLOSED') {
      breaker.failures = Math.max(0, breaker.failures - 1); // Decrement failures on success
    }
  }
  
  isCircuitOpen(service) {
    const breaker = this.getCircuitBreaker(service);
    return breaker.state === 'OPEN';
  }
  
  // Share history and hashrate tracking
  pruneShareHistory() {
    const cutoffTime = Date.now() - CONFIG.hashrateWindow;
    let totalPruned = 0;
    
    this.workerStats.forEach((workerStat, workerKey) => {
      if (!workerStat.shareHistory || !Array.isArray(workerStat.shareHistory)) {
        workerStat.shareHistory = [];
        return;
      }
      
      const beforeSize = workerStat.shareHistory.length;
      
      // If empty or all entries are recent, skip
      if (beforeSize === 0 || workerStat.shareHistory[0] >= cutoffTime) {
        return;
      }
      
      // Use binary search to find cutoff index for better performance
      let left = 0;
      let right = beforeSize - 1;
      let cutoffIndex = 0;
      
      while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (workerStat.shareHistory[mid] < cutoffTime) {
          cutoffIndex = mid + 1;
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }
      
      if (cutoffIndex > 0) {
        workerStat.shareHistory = workerStat.shareHistory.slice(cutoffIndex);
        totalPruned += cutoffIndex;
      }
    });
    
    if (totalPruned > 0 && CONFIG.verbose) {
      logger('debug', `Pruned ${totalPruned} old share history entries`);
    }
  }
  
  calculateHashrate(shareHistory) {
    if (!shareHistory || !Array.isArray(shareHistory) || shareHistory.length === 0) {
      return 0;
    }
    
    const now = Date.now();
    const windowStart = now - CONFIG.hashrateWindow;
    
    const recentShares = shareHistory.length;
    
    if (recentShares === 0) {
      return 0;
    }
    
    const avgDifficulty = CONFIG.xmrShareDifficulty;
    const windowSizeInSeconds = CONFIG.hashrateWindow / 1000;
    const hashrate = (recentShares * avgDifficulty) / windowSizeInSeconds;
    
    return hashrate;
  }
  
  checkAndResetShares() {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    
    if (day === CONFIG.resetDay && hour === CONFIG.resetHour && minute === CONFIG.resetMinute) {
      const lastResetTime = this.lastShareReset ? new Date(this.lastShareReset) : null;
      if (!lastResetTime || 
          lastResetTime.getUTCDay() !== day ||
          lastResetTime.getUTCHours() !== hour ||
          lastResetTime.getUTCMinutes() !== minute) {
        
        logger('info', `Weekly reset triggered at ${now.toISOString()}`);
        this.resetAllShares();
      }
    }
  }
  
  resetAllShares() {
    const previousTotal = this.totalShares;
    this.totalShares = 0;
    
    let resetCount = 0;
    this.workerStats.forEach((workerStat, workerKey) => {
      if (workerStat.shares > 0) {
        resetCount++;
        workerStat.shares = 0;
        workerStat.shareHistory = [];
        this.workerStats.set(workerKey, workerStat);
      }
    });
    
    this.lastShareReset = new Date().toISOString();
    
    logger('info', `Reset ${resetCount} workers, previous total: ${previousTotal} shares`);
  }
  
  getWorkerKey(wallet, workerName) {
    return `${wallet || 'unknown'}.${workerName || 'default'}`;
  }
  
  getOrCreateWorkerStats(wallet, workerName) {
    const workerKey = this.getWorkerKey(wallet, workerName);
    
    if (!this.workerStats.has(workerKey)) {
      this.workerStats.set(workerKey, {
        wallet: wallet || 'unknown',
        workerName: workerName || 'default',
        shares: 0,
        shareHistory: [],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        activeConnections: new Set()
      });
    }
    
    return this.workerStats.get(workerKey);
  }
  
  sendKeepaliveToMiners() {
    this.miners.forEach((minerInfo, minerId) => {
      if (minerInfo.connected && minerInfo.socket && minerInfo.socket.writable) {
        minerInfo.lastActivity = Date.now();
        this.miners.set(minerId, minerInfo);
      }
    });
  }
  
  analyzeComputorDistribution() {
    // Count computors in each group
    const groupCounts = [
      this.computorDistribution.filter(c => c.index >= 0 && c.index <= 168).length,
      this.computorDistribution.filter(c => c.index >= 169 && c.index <= 337).length,
      this.computorDistribution.filter(c => c.index >= 338 && c.index <= 506).length,
      this.computorDistribution.filter(c => c.index >= 507 && c.index <= 675).length
    ];
    
    logger('info', `Computor distribution: G1:${groupCounts[0]} G2:${groupCounts[1]} G3:${groupCounts[2]} G4:${groupCounts[3]}`);
    return groupCounts;
  }
}

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

// Network Helper for buffered reading
class NetworkHelper {
  static setupBufferedSocket(socket, messageHandler, options = {}) {
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

// Classes for each component
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
    
    // Handle incoming data with specialized parsing for task source
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
      
      // Safety check to prevent memory DOS attacks
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
          // Try to find a complete JSON object
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
            break; // No complete JSON object found
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
      logger('debug', `Received task type: ${message.method || 'Unknown'}`);
      
      if (message.method === 'job') {
        if (message.job && message.job.job_id && message.job.job_id === this.state.lastJobId) {
          logger('debug', `Ignoring duplicate job ID: ${message.job.job_id}`);
          return;
        }
        
        // Track task processing statistics
        this.state.taskStats.processed++;
        this.state.taskStats.lastProcessed = new Date().toISOString();
        
        // Add defaults if not provided
        message.job.first_computor_index = message.job.first_computor_index || 0;
        message.job.last_computor_index = message.job.last_computor_index || 675;
        
        // Identify which group this task belongs to (for logging)
        let groupId = 0;
        if (message.job.first_computor_index >= 0 && message.job.first_computor_index <= 168) groupId = 1;
        else if (message.job.first_computor_index >= 169 && message.job.first_computor_index <= 337) groupId = 2;
        else if (message.job.first_computor_index >= 338 && message.job.first_computor_index <= 506) groupId = 3;
        else if (message.job.first_computor_index >= 507 && message.job.first_computor_index <= 675) groupId = 4;
        
        logger('job', `New job: ${message.job.job_id}, height: ${message.job.height}, computor group: ${groupId} (range: ${message.job.first_computor_index}-${message.job.last_computor_index})`);
        
        // Check if we have any valid computors for this job - use cached results when possible
        const rangeKey = `${message.job.first_computor_index}-${message.job.last_computor_index}`;
        let hasValidComputors = false;
        
        if (this.state.validComputorsCache && this.state.validComputorsCache.has(rangeKey)) {
          hasValidComputors = this.state.validComputorsCache.get(rangeKey).length > 0;
        } else {
          // Calculate and cache for future use
          const validComputors = this.state.computorDistribution.filter(
            item => item.index >= message.job.first_computor_index && 
                   item.index <= message.job.last_computor_index
          );
          
          if (this.state.validComputorsCache) {
            this.state.validComputorsCache.set(rangeKey, validComputors);
          }
          
          hasValidComputors = validComputors.length > 0;
        }
        
        if (!hasValidComputors) {
          logger('job', `No valid computors for job in group ${groupId}, not mining`);
          this.state.taskStats.skipped++;
          // Still store the job in case a computor becomes valid later
          this.state.storeRecentJob(message);
        } else {
          // We have valid computors for this job
          this.state.taskStats.mined++;
          // Emit job event to trigger broadcasting
          this.state.emit('job', message);
        }
        
        // Track processing time
        const processingTime = Date.now() - startTime;
        this.state.taskStats.processingTimes.push(processingTime);
        
        // Keep only the last 100 processing times
        if (this.state.taskStats.processingTimes.length > 100) {
          this.state.taskStats.processingTimes.shift();
        }
      }
    } catch (error) {
      logger('error', `Error processing task message: ${error.message}`);
    }
  }
}

class MinerServer {
  constructor(state) {
    this.state = state;
    this.server = null;
    
    // Listen for job broadcasts
    this.state.on('broadcastJob', (job) => {
      this.broadcastJob(job);
    });
  }
  
  start() {
    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });
    
    this.server.on('error', (err) => {
      logger('error', `Miner server error: ${err.message}`);
    });
    
    this.server.listen(CONFIG.minerPort, '0.0.0.0', () => {
      logger('info', `Miner server listening on port ${CONFIG.minerPort}`);
    });
  }
  
  handleConnection(socket) {
    const ip = socket.remoteAddress;
    const port = socket.remotePort;
    const minerId = `${ip}:${port}`;
    
    // Check rate limiting
    if (this.state.isRateLimited(ip)) {
      logger('warn', `Rate limit exceeded for ${ip}, connection refused`);
      socket.end('Rate limit exceeded');
      return;
    }
    
    logger('info', `Miner connected: ${minerId}`);
    
    // Set login timeout
    const loginTimeout = setTimeout(() => {
      if (socket.writable) {
        logger('warn', `Login timeout for ${minerId}, closing connection`);
        socket.end('Login timeout');
      }
    }, CONFIG.loginTimeout);
    
    this.state.miners.set(minerId, {
      socket: socket,
      wallet: null,
      workerName: null,
      workerKey: null,
      shares: 0,
      connected: true,
      lastActivity: Date.now(),
      nonceRange: null
    });
    
    // Setup buffered socket processing
    NetworkHelper.setupBufferedSocket(socket, (message) => {
      clearTimeout(loginTimeout); // Clear timeout on first message
      this.handleMinerMessage(minerId, message);
    });
    
    socket.on('end', () => {
      this.handleMinerDisconnect(minerId);
    });
    
    socket.on('error', (err) => {
      logger('error', `Miner socket error for ${minerId}: ${err.message}`);
    });
    
    socket.on('close', () => {
      this.handleMinerDisconnect(minerId);
    });
  }
  
  handleMinerDisconnect(minerId) {
    logger('info', `Miner disconnected: ${minerId}`);
    const minerInfo = this.state.miners.get(minerId);
    if (minerInfo) {
      minerInfo.connected = false;
      this.state.miners.set(minerId, minerInfo);
      
      if (minerInfo.workerKey) {
        const workerStat = this.state.workerStats.get(minerInfo.workerKey);
        if (workerStat) {
          workerStat.activeConnections.delete(minerId);
          workerStat.lastSeen = new Date().toISOString();
          this.state.workerStats.set(minerInfo.workerKey, workerStat);
        }
      }
    }
  }
  
  handleMinerMessage(minerId, message) {
    try {
      logger('debug', `Received from ${minerId}: ${message.method}`);
      
      const minerInfo = this.state.miners.get(minerId);
      if (!minerInfo) return;
      
      minerInfo.lastActivity = Date.now();
      this.state.miners.set(minerId, minerInfo);
      
      switch (message.method) {
        case 'login':
          this.handleLogin(minerId, message);
          break;
          
        case 'keepalived':
        case 'keepalive':
          this.handleKeepalive(minerId, message);
          break;
          
        case 'getjob':
          this.handleGetJob(minerId, message);
          break;
          
        case 'submit':
          this.handleSubmit(minerId, message);
          break;
          
        default:
          this.sendDefaultResponse(minerId, message);
      }
    } catch (error) {
      logger('error', `Error processing miner message from ${minerId}: ${error.message}`);
    }
  }
  
  handleLogin(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo) return;
    
    if (message.params && message.params.login) {
      const loginParts = message.params.login.split('.');
      minerInfo.wallet = loginParts[0];
      minerInfo.workerName = loginParts.length > 1 ? loginParts[1] : 'default';
      minerInfo.workerKey = this.state.getWorkerKey(minerInfo.wallet, minerInfo.workerName);
      minerInfo.lastSeen = new Date().toISOString();
      
      this.state.miners.set(minerId, minerInfo);
      
      const workerStat = this.state.getOrCreateWorkerStats(minerInfo.wallet, minerInfo.workerName);
      workerStat.activeConnections.add(minerId);
      workerStat.lastSeen = new Date().toISOString();
      this.state.workerStats.set(minerInfo.workerKey, workerStat);
      
      logger('info', `Miner ${minerId} logged in: ${minerInfo.wallet}, worker: ${minerInfo.workerName}`);
    }
    
    // Send login response with job if available
    if (this.state.currentJob) {
      // Check if we have a valid computor for the current job
      const computorIndex = this.state.getNextComputorIndex(
        this.state.currentJob.job.first_computor_index,
        this.state.currentJob.job.last_computor_index,
        minerInfo.workerKey
      );
      
      if (computorIndex === null) {
        logger('debug', `No valid computor for login response, not sending job to ${minerId}`);
        this.sendBasicLoginResponse(minerId, message);
      } else {
        // Send complete login response with job
        this.sendLoginWithJobResponse(minerId, message, computorIndex);
      }
    } else {
      // No valid job, send basic login response
      this.sendBasicLoginResponse(minerId, message);
    }
  }
  
  sendBasicLoginResponse(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    const basicLoginResponse = {
      id: message.id,
      jsonrpc: "2.0",
      error: null,
      result: {
        id: minerId,
        status: "OK"
      }
    };
    
    minerInfo.socket.write(JSON.stringify(basicLoginResponse) + '\n');
  }
  
  sendLoginWithJobResponse(minerId, message, computorIndex) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable || !this.state.currentJob) return;
    
    // Calculate nonce range based on computor index
    const nonceRange = this.state.allocateNonceRange(
      this.state.currentJob.job.job_id,
      computorIndex,
      this.state.currentJob.job.first_computor_index,
      this.state.currentJob.job.last_computor_index
    );
    
    minerInfo.nonceRange = nonceRange;
    this.state.miners.set(minerId, minerInfo);
    
    logger('debug', `Allocated nonce range: ${nonceRange.start_nonce} - ${nonceRange.end_nonce} for computor ${nonceRange.computorIndex}`);
    
    const loginResponse = {
      id: message.id,
      jsonrpc: "2.0",
      error: null,
      result: {
        id: minerId,
        status: "OK",
        job: {
          blob: this.state.currentJob.job.blob,
          job_id: this.state.currentJob.job.job_id,
          target: this.state.currentJob.job.target,
          id: minerId,
          seed_hash: this.state.currentJob.job.seed_hash,
          height: this.state.currentJob.job.height,
          algo: this.state.currentJob.job.algo || "rx/0",
          computorIndex: nonceRange.computorIndex,
          start_nonce: nonceRange.start_nonce,
          end_nonce: nonceRange.end_nonce,
          first_computorIndex: this.state.currentJob.job.first_computor_index,
          last_computorIndex: this.state.currentJob.job.last_computor_index
        }
      }
    };
    
    minerInfo.socket.write(JSON.stringify(loginResponse) + '\n');
  }
  
  handleKeepalive(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    const pongResponse = {
      id: message.id || 0,
      jsonrpc: "2.0",
      error: null,
      result: {
        status: "OK"
      }
    };
    
    minerInfo.socket.write(JSON.stringify(pongResponse) + '\n');
    
    if (CONFIG.logKeepalive) {
      logger('debug', `Sent keepalive response to ${minerId}`);
    }
  }
  
  handleGetJob(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    if (this.state.currentJob) {
      // Check if we have a valid computor for the current job
      const computorIndex = this.state.getNextComputorIndex(
        this.state.currentJob.job.first_computor_index,
        this.state.currentJob.job.last_computor_index,
        minerInfo.workerKey
      );
      
      if (computorIndex === null) {
        logger('debug', `No valid computor for getjob request from ${minerId}`);
        this.sendEmptyJobResponse(minerId, message);
      } else {
        // Calculate nonce range based on computor index
        const nonceRange = this.state.allocateNonceRange(
          this.state.currentJob.job.job_id,
          computorIndex,
          this.state.currentJob.job.first_computor_index,
          this.state.currentJob.job.last_computor_index
        );
        
        minerInfo.nonceRange = nonceRange;
        this.state.miners.set(minerId, minerInfo);
        
        const jobResponse = {
          id: message.id,
          jsonrpc: "2.0",
          error: null,
          result: {
            blob: this.state.currentJob.job.blob,
            job_id: this.state.currentJob.job.job_id,
            target: this.state.currentJob.job.target,
            id: minerId,
            seed_hash: this.state.currentJob.job.seed_hash,
            height: this.state.currentJob.job.height,
            algo: this.state.currentJob.job.algo || "rx/0",
            computorIndex: nonceRange.computorIndex,
            start_nonce: nonceRange.start_nonce,
            end_nonce: nonceRange.end_nonce,
            first_computorIndex: this.state.currentJob.job.first_computor_index,
            last_computorIndex: this.state.currentJob.job.last_computor_index
          }
        };
        
        minerInfo.socket.write(JSON.stringify(jobResponse) + '\n');
        
        if (CONFIG.logDetailedMinerEvents) {
          logger('debug', `Sent job to ${minerId} with computor ${nonceRange.computorIndex}, nonce: ${nonceRange.start_nonce}-${nonceRange.end_nonce}`);
        }
      }
    } else {
      this.sendEmptyJobResponse(minerId, message);
    }
  }
  
  sendEmptyJobResponse(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    const emptyJobResponse = {
      id: message.id,
      jsonrpc: "2.0",
      error: null,
      result: { status: "NO_JOB" }
    };
    
    minerInfo.socket.write(JSON.stringify(emptyJobResponse) + '\n');
  }
  
  handleSubmit(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.workerKey) return;
    
    minerInfo.shares++;
    minerInfo.lastSeen = new Date().toISOString();
    this.state.miners.set(minerId, minerInfo);
    
    const workerStat = this.state.workerStats.get(minerInfo.workerKey);
    if (workerStat) {
      workerStat.shares++;
      workerStat.lastSeen = new Date().toISOString();
      
      // Add timestamp to share history
      workerStat.shareHistory.push(Date.now());
      
      this.state.workerStats.set(minerInfo.workerKey, workerStat);
    }
    
    // Find the correct job for this nonce
    const submittedNonce = parseInt(message.params.nonce);
    let jobId = message.params.job_id || null;
    
    // If job_id wasn't provided or doesn't exist in our cache, try to find it from nonce range
    if (!jobId || !this.state.recentJobs.has(jobId)) {
      const jobInfo = this.state.findJobForNonce(submittedNonce);
      if (jobInfo) {
        jobId = jobInfo.jobId;
      }
    }
    
    // Get the job data from our cache
    const jobForShare = jobId && this.state.recentJobs.has(jobId) 
      ? this.state.recentJobs.get(jobId) 
      : this.state.currentJob;
    
    if (jobId && jobId !== this.state.currentJob.job.job_id) {
      logger('share', `Share for previous job: ${jobId} (current: ${this.state.currentJob.job.job_id})`);
    }
    
    logger('share', `Miner ${minerId} (${minerInfo.wallet}) found a share! Total: ${workerStat ? workerStat.shares : minerInfo.shares}`);
    
    this.sendShareResponse(minerId, message);
    
    // Create a share message with first_computor_index and last_computor_index
    if (jobForShare && jobForShare.job) {
      const simplifiedShareMessage = {
        params: {
          nonce: message.params.nonce,
          result: message.params.result
        },
        task_id: jobForShare.id || null,
        task_seed_hash: jobForShare.job.seed_hash || null,
        first_computor_index: jobForShare.job.first_computor_index || 0,
        last_computor_index: jobForShare.job.last_computor_index || 675
      };
      
      this.state.emit('share', simplifiedShareMessage);
    } else {
      logger('warn', `Cannot distribute share without valid job information`);
    }
  }
  
  sendShareResponse(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    const shareResponse = {
      id: message.id,
      jsonrpc: "2.0",
      error: null,
      result: {
        status: "OK"
      }
    };
    
    minerInfo.socket.write(JSON.stringify(shareResponse) + '\n');
  }
  
  sendDefaultResponse(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    const defaultResponse = {
      id: message.id || 0,
      jsonrpc: "2.0",
      error: null,
      result: {
        status: "OK"
      }
    };
    
    minerInfo.socket.write(JSON.stringify(defaultResponse) + '\n');
    
    if (CONFIG.logDetailedMinerEvents) {
      logger('debug', `Default response for ${message.method} to ${minerId}`);
    }
  }
  
  broadcastJob(job) {
    let activeMiners = 0;
    let skippedMiners = 0;
    
    if (!job) {
      logger('job', `No job to broadcast`);
      return;
    }
    
    // Determine which group this job belongs to
    let jobGroup = 0;
    if (job.job.first_computor_index >= 0 && job.job.first_computor_index <= 168) jobGroup = 1;
    else if (job.job.first_computor_index >= 169 && job.job.first_computor_index <= 337) jobGroup = 2;
    else if (job.job.first_computor_index >= 338 && job.job.first_computor_index <= 506) jobGroup = 3;
    else if (job.job.first_computor_index >= 507 && job.job.first_computor_index <= 675) jobGroup = 4;
    
    // Save this task as the latest for its group
    if (jobGroup > 0 && this.state.lastGroupTask) {
      this.state.lastGroupTask.set(jobGroup, {
        jobId: job.job.job_id,
        time: Date.now()
      });
    }
    
    // Clean up invalid assignments before broadcasting
    this.state.cleanupInvalidComputorAssignments(
      job.job.first_computor_index,
      job.job.last_computor_index
    );
    
    // Keep track of worker counts by group for statistics
    const workersByGroup = [0, 0, 0, 0]; // For groups 1-4
    
    this.state.miners.forEach((minerInfo, minerId) => {
      if (minerInfo.connected && minerInfo.socket && minerInfo.socket.writable && minerInfo.workerKey) {
        // Get worker's current preferred group (if any)
        const preferredGroup = this.state.workerGroupAssignments.get(minerInfo.workerKey) || 0;
        
        // unless they don't have a preferred group yet (preferredGroup === 0)
        if (preferredGroup !== 0 && preferredGroup !== jobGroup) {
          // Check how long since the last group switch before deciding whether to skip
          const lastGroupSwitchTime = this.state.workerGroupAssignments.get(`${minerInfo.workerKey}_switchTime`) || 0;
          const timeSinceSwitch = Date.now() - lastGroupSwitchTime;
          
          if (timeSinceSwitch < this.state.groupSwitchCooldown) {
            logger('debug', `Skipping task broadcast for miner ${minerId} - assigned to group ${preferredGroup}, but task is for group ${jobGroup}`);
            skippedMiners++;
            return; // Skip this miner
          }
        }
        
        // Check if we have a valid computor for the current job
        // Use the worker's key to get a consistent computor assignment
        const computorIndex = this.state.getNextComputorIndex(
          job.job.first_computor_index,
          job.job.last_computor_index,
          minerInfo.workerKey
        );
        
        if (computorIndex === null) {
          logger('debug', `No valid computor for broadcast to miner ${minerId}`);
          skippedMiners++;
          return; // Skip this miner
        }
        
        // Calculate nonce range based on computor index
        const nonceRange = this.state.allocateNonceRange(
          job.job.job_id,
          computorIndex,
          job.job.first_computor_index,
          job.job.last_computor_index
        );
        
        minerInfo.nonceRange = nonceRange;
        this.state.miners.set(minerId, minerInfo);
        
        // Track which group this worker is assigned to
        let workerGroup = 0;
        if (computorIndex >= 0 && computorIndex <= 168) workerGroup = 1;
        else if (computorIndex >= 169 && computorIndex <= 337) workerGroup = 2;
        else if (computorIndex >= 338 && computorIndex <= 506) workerGroup = 3;
        else if (computorIndex >= 507 && computorIndex <= 675) workerGroup = 4;
        
        if (workerGroup > 0) {
          workersByGroup[workerGroup - 1]++;
        }
        
        const minerJob = {
          jsonrpc: "2.0",
          method: "job",
          params: {
            blob: job.job.blob,
            job_id: job.job.job_id,
            target: job.job.target,
            id: minerId,
            seed_hash: job.job.seed_hash,
            height: job.job.height,
            algo: job.job.algo || "rx/0",
            computorIndex: nonceRange.computorIndex,
            start_nonce: nonceRange.start_nonce,
            end_nonce: nonceRange.end_nonce,
            first_computorIndex: job.job.first_computor_index,
            last_computorIndex: job.job.last_computor_index
          }
        };
        
        try {
          minerInfo.socket.write(JSON.stringify(minerJob) + '\n');
          activeMiners++;
        } catch (error) {
          logger('error', `Error sending job to miner ${minerId}: ${error.message}`);
          minerInfo.connected = false;
          this.state.miners.set(minerId, minerInfo);
        }
      }
    });
    
    // CHANGE #3.2: Improved logging for task broadcast decisions
    logger('job', `Job for group ${jobGroup} broadcast to ${activeMiners} miners, skipped ${skippedMiners} miners. Distribution: G1:${workersByGroup[0]} G2:${workersByGroup[1]} G3:${workersByGroup[2]} G4:${workersByGroup[3]}`);
  }
}

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
    
    this.server.listen(CONFIG.shareDistributionPort, '0.0.0.0', () => {
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
    
    if (CONFIG.verbose) {
      logger('debug', `Share distribution details: task_id: ${message.task_id}, hash: ${message.task_seed_hash}, computor range: ${message.first_computor_index}-${message.last_computor_index}`);
    }
    
    if (distributedTo === 0 && this.clients.size === 0) {
      logger('warn', `No share clients connected`);
    }
  }
}

class StatisticsManager {
  constructor(state) {
    this.state = state;
  }
  
  async saveStatsToFile() {
    const stats = this.generateStats();
    await FileHelper.saveJSON(CONFIG.statsPath, stats);
  }
  
  async savePersistentStats() {
    const persistentData = {
      totalShares: this.state.totalShares,
      lastShareReset: this.state.lastShareReset,
      workers: Array.from(this.state.workerStats.entries()).map(([key, data]) => {
        const cleanedData = JSON.parse(JSON.stringify(data));
        
        // Remove fields we don't want to persist
        delete cleanedData.firstSeen;
        delete cleanedData.totalConnections;
        delete cleanedData.activeConnections;
        
        return [key, cleanedData];
      }),
      savedAt: new Date().toISOString()
    };
    
    await FileHelper.saveJSON(CONFIG.persistentStatsPath, persistentData);
    
    // Also save computor assignments
    await this.saveComputorAssignments();
  }
  
  async saveComputorAssignments() {
    const assignmentsData = Array.from(this.state.minerComputorAssignments.entries());
    await FileHelper.saveJSON(CONFIG.computorAssignmentsPath, assignmentsData);
  }
  
  async saveComputorDistribution() {
    try {
      // Order computors by index for better organization
      this.state.computorDistribution.sort((a, b) => a.index - b.index);
      
      // Save distribution
      await FileHelper.saveJSON(CONFIG.computorIndexesPath, this.state.computorDistribution);
      
      // Clear cache after saving
      if (this.state.validComputorsCache) {
        this.state.validComputorsCache.clear();
      }
      
      // Analyze distribution
      this.state.analyzeComputorDistribution();
      
      logger('debug', `Computor distribution saved with ${this.state.computorDistribution.length} computors`);
      return true;
    } catch (error) {
      logger('error', `Error saving computor distribution: ${error.message}`);
      return false;
    }
  }
  
  async loadPersistentStats() {
    try {
      // Try to load with async method first
      const persistentData = await FileHelper.loadJSON(CONFIG.persistentStatsPath);
      
      if (persistentData) {
        this.state.totalShares = persistentData.totalShares || 0;
        this.state.lastShareReset = persistentData.lastShareReset;
        
        if (persistentData.workers && Array.isArray(persistentData.workers)) {
          for (const [key, data] of persistentData.workers) {
            if (!data.firstSeen) {
              data.firstSeen = new Date().toISOString();
            }
            if (!data.totalConnections) {
              data.totalConnections = 0;
            }
            
            data.activeConnections = new Set();
            // Ensure shareHistory is an array
            if (!data.shareHistory || !Array.isArray(data.shareHistory)) {
              data.shareHistory = [];
            }
            this.state.workerStats.set(key, data);
          }
        }
        
        logger('info', `Loaded stats: ${this.state.workerStats.size} workers, ${this.state.totalShares} shares`);
        if (this.state.lastShareReset) {
          logger('info', `Last reset: ${new Date(this.state.lastShareReset).toISOString()}`);
        }
      } else {
        // Fallback to sync method for compatibility
        this.loadPersistentStatsSync();
      }
    } catch (error) {
      logger('warn', `Error loading persistent stats with async method: ${error.message}`);
      logger('info', `Falling back to sync method to load stats`);
      // Fallback to sync method
      this.loadPersistentStatsSync();
    }
    
    if (!this.state.lastShareReset) {
      this.state.lastShareReset = new Date().toISOString();
    }
    
    return true;
  }
  
  loadPersistentStatsSync() {
    try {
      if (fsSync.existsSync(CONFIG.persistentStatsPath)) {
        const data = fsSync.readFileSync(CONFIG.persistentStatsPath, 'utf8');
        const persistentData = JSON.parse(data);
        
        this.state.totalShares = persistentData.totalShares || 0;
        this.state.lastShareReset = persistentData.lastShareReset;
        
        if (persistentData.workers && Array.isArray(persistentData.workers)) {
          persistentData.workers.forEach(([key, data]) => {
            if (!data.firstSeen) {
              data.firstSeen = new Date().toISOString();
            }
            if (!data.totalConnections) {
              data.totalConnections = 0;
            }
            
            data.activeConnections = new Set();
            // Ensure shareHistory is an array
            if (!data.shareHistory || !Array.isArray(data.shareHistory)) {
              data.shareHistory = [];
            }
            this.state.workerStats.set(key, data);
          });
        }
        
        logger('info', `Loaded stats: ${this.state.workerStats.size} workers, ${this.state.totalShares} shares`);
        if (this.state.lastShareReset) {
          logger('info', `Last reset: ${new Date(this.state.lastShareReset).toISOString()}`);
        }
      } else {
        logger('info', `No stats file found, starting with fresh stats`);
      }
    } catch (error) {
      logger('error', `Error loading stats: ${error.message}`);
      logger('info', `Starting with fresh stats`);
    }
  }
  
  async loadComputorSettings() {
    try {
      // Try to load with async method first
      const distribution = await FileHelper.loadJSON(CONFIG.computorIndexesPath);
      
      if (distribution) {
        this.state.computorDistribution = distribution;
        logger('info', `Loaded computor distribution with ${distribution.length} entries`);
      } else {
        // Fallback to sync method
        this.loadComputorSettingsSync();
      }
    } catch (error) {
      logger('warn', `Error loading computor settings with async method: ${error.message}`);
      logger('info', `Falling back to sync method`);
      // Fallback to sync method
      this.loadComputorSettingsSync();
    }
    
    return true;
  }
  
  loadComputorSettingsSync() {
    try {
      // Load computor distribution
      if (fsSync.existsSync(CONFIG.computorIndexesPath)) {
        const data = fsSync.readFileSync(CONFIG.computorIndexesPath, 'utf8');
        this.state.computorDistribution = JSON.parse(data);
        logger('info', `Loaded computor distribution with ${this.state.computorDistribution.length} entries`);
      } else {
        // Initialize with default
        this.state.computorDistribution = [{
          index: 0,
          weight: 100,
          identity: null
        }];
        logger('info', `No distribution file found, using default index: 0 with 100% weight`);
        this.saveComputorDistribution(); // Save with sync method
      }
    } catch (error) {
      logger('error', `Error loading settings: ${error.message}`);
      // Initialize with default
      this.state.computorDistribution = [{
        index: 0,
        weight: 100,
        identity: null
      }];
      logger('info', `Using default distribution due to error`);
    }
  }
  
  async loadComputorAssignments() {
    try {
      // Try to load with async method first
      const assignmentsData = await FileHelper.loadJSON(CONFIG.computorAssignmentsPath);
      
      if (assignmentsData) {
        // Clear existing assignments
        this.state.minerComputorAssignments.clear();
        
        // Load saved assignments
        for (const [workerKey, computorIndex] of assignmentsData) {
          this.state.minerComputorAssignments.set(workerKey, computorIndex);
        }
        
        logger('info', `Loaded ${this.state.minerComputorAssignments.size} computor assignments`);
      } else {
        // Fallback to sync method
        this.loadComputorAssignmentsSync();
      }
    } catch (error) {
      logger('warn', `Error loading computor assignments with async method: ${error.message}`);
      logger('info', `Falling back to sync method`);
      // Fallback to sync method
      this.loadComputorAssignmentsSync();
    }
    
    return true;
  }
  
  loadComputorAssignmentsSync() {
    try {
      if (fsSync.existsSync(CONFIG.computorAssignmentsPath)) {
        const data = fsSync.readFileSync(CONFIG.computorAssignmentsPath, 'utf8');
        const assignmentsData = JSON.parse(data);
        
        // Clear existing assignments
        this.state.minerComputorAssignments.clear();
        
        // Load saved assignments
        for (const [workerKey, computorIndex] of assignmentsData) {
          this.state.minerComputorAssignments.set(workerKey, computorIndex);
        }
        
        logger('info', `Loaded ${this.state.minerComputorAssignments.size} computor assignments`);
      } else {
        logger('info', `No computor assignments file found`);
      }
    } catch (error) {
      logger('error', `Error loading computor assignments: ${error.message}`);
    }
  }
  
  generateStats() {
    const stats = {
      totalShares: this.state.totalShares,
      lastShareReset: this.state.lastShareReset,
      computorDistribution: this.state.computorDistribution,
      currentEpoch: this.state.currentEpoch,
      minerCount: {
        total: this.state.miners.size,
        active: Array.from(this.state.miners.values()).filter(m => m.connected).length
      },
      workers: [],
      currentTime: new Date().toISOString(),
      uptime: process.uptime(),
      computorAssignments: Array.from(this.state.minerComputorAssignments).map(([worker, index]) => {
        return { worker, index };
      }),
      
      // Add task processing statistics
      taskStats: {
        processed: this.state.taskStats.processed,
        skipped: this.state.taskStats.skipped,
        mined: this.state.taskStats.mined,
        byGroup: this.state.taskStats.byGroup || [0, 0, 0, 0],
        lastProcessed: this.state.taskStats.lastProcessed,
        avgProcessingTime: this.state.taskStats.processingTimes.length > 0 
          ? this.state.taskStats.processingTimes.reduce((a, b) => a + b, 0) / this.state.taskStats.processingTimes.length 
          : 0
      },
      
      // Add computor groups statistics
      computorGroups: [
        { 
          id: 1, 
          range: "0-168", 
          count: this.state.computorDistribution.filter(c => c.index >= 0 && c.index <= 168).length 
        },
        { 
          id: 2, 
          range: "169-337", 
          count: this.state.computorDistribution.filter(c => c.index >= 169 && c.index <= 337).length 
        },
        { 
          id: 3, 
          range: "338-506", 
          count: this.state.computorDistribution.filter(c => c.index >= 338 && c.index <= 506).length 
        },
        { 
          id: 4, 
          range: "507-675", 
          count: this.state.computorDistribution.filter(c => c.index >= 507 && c.index <= 675).length 
        }
      ],
      
      // Information about task distribution
      taskDistribution: {
        totalComputors: 676, // 0-675
        groups: 4,
        groupRanges: [
          [0, 168],
          [169, 337],
          [338, 506],
          [507, 675]
        ]
      },
      
      // Group assignments for workers
      workerGroupAssignments: Array.from(this.state.workerGroupAssignments)
        .filter(([key, _]) => !key.includes('_switchTime'))
        .map(([worker, group]) => {
          return { worker, group };
        })
    };
    
    let totalHashrate = 0;
    
    this.state.workerStats.forEach((workerStat, workerKey) => {
      const hashrate = this.state.calculateHashrate(workerStat.shareHistory);
      totalHashrate += hashrate;
      
      const isActive = workerStat.activeConnections && workerStat.activeConnections.size > 0;
      const assignedComputor = this.state.minerComputorAssignments.get(workerKey) || null;
      
      // Add which group this worker's computor belongs to
      let groupId = null;
      if (assignedComputor !== null) {
        if (assignedComputor >= 0 && assignedComputor <= 168) groupId = 1;
        else if (assignedComputor >= 169 && assignedComputor <= 337) groupId = 2;
        else if (assignedComputor >= 338 && assignedComputor <= 506) groupId = 3;
        else if (assignedComputor >= 507 && assignedComputor <= 675) groupId = 4;
      }
      
      // Get worker's preferred group
      const preferredGroup = this.state.workerGroupAssignments.get(workerKey) || 0;
      
      stats.workers.push({
        workerKey,
        wallet: workerStat.wallet,
        workerName: workerStat.workerName,
        shares: workerStat.shares,
        active: isActive,
        lastSeen: workerStat.lastSeen,
        hashrate,
        hashrateFormatted: formatHashrate(hashrate),
        assignedComputor,
        computorGroup: groupId,
        preferredGroup: preferredGroup
      });
    });
    
    stats.workers.sort((a, b) => b.hashrate - a.hashrate);
    
    stats.totalHashrate = totalHashrate;
    stats.totalHashrateFormatted = formatHashrate(totalHashrate);
    
    return stats;
  }
  
  async fetchComputorList(epoch) {
    try {
      if (this.state.isCircuitOpen('computorApi')) {
        logger('warn', `Circuit breaker open for computor API, skipping fetch`);
        return null;
      }
      
      const url = `https://${CONFIG.rpcEndpoint}/v1/epochs/${epoch}/computors`;
      logger('info', `Fetching computor list for epoch ${epoch}...`);
      
      const response = await NetworkHelper.httpFetch(url);
      
      if (response && response.data) {
        const result = JSON.parse(response.data);
        if (result && result.computors && Array.isArray(result.computors.identities)) {
          this.state.computorIdentities = result.computors.identities;
          this.state.currentEpoch = epoch;
          logger('info', `Loaded ${this.state.computorIdentities.length} computor identities for epoch ${epoch}`);
          
          // Update existing distribution with identity information
          this.state.computorDistribution = this.state.computorDistribution.map(item => {
            if (item.index >= 0 && item.index < this.state.computorIdentities.length) {
              item.identity = this.state.computorIdentities[item.index];
            }
            return item;
          });
          
          this.state.emit('computorDistributionChanged');
          await this.saveComputorDistribution();
          this.state.recordSuccess('computorApi');
          return this.state.computorIdentities;
        }
      }
      
      throw new Error('Invalid API response format');
    } catch (error) {
      this.state.recordFailure('computorApi');
      logger('error', `Error fetching computor list: ${error.message}`);
      return null;
    }
  }
  
  logPeriodicStats() {
    const stats = this.generateStats();
    
    logger('info', '--- Mining Stats ---');
    logger('info', `Shares: ${stats.totalShares} | Hashrate: ${stats.totalHashrateFormatted}`);
    logger('info', `Miners: ${stats.minerCount.active}/${stats.minerCount.total} | Configured Computors: ${stats.computorDistribution.length}`);
    
    // Log stats by computor group
    logger('info', `Computor Groups: G1(0-168):${stats.computorGroups[0].count} G2(169-337):${stats.computorGroups[1].count} G3(338-506):${stats.computorGroups[2].count} G4(507-675):${stats.computorGroups[3].count}`);
    
    // Log task processing stats
    if (stats.taskStats) {
      logger('info', `Tasks: Processed: ${stats.taskStats.processed} | Mined: ${stats.taskStats.mined} | Skipped: ${stats.taskStats.skipped}`);
      
      // Log tasks by group
      if (stats.taskStats.byGroup && stats.taskStats.byGroup.length === 4) {
        logger('info', `Tasks by Group: G1:${stats.taskStats.byGroup[0]} G2:${stats.taskStats.byGroup[1]} G3:${stats.taskStats.byGroup[2]} G4:${stats.taskStats.byGroup[3]}`);
      }
      
      if (stats.taskStats.avgProcessingTime) {
        logger('info', `Avg. Task Processing: ${stats.taskStats.avgProcessingTime.toFixed(2)} ms`);
      }
    }
    
    // Count workers by group
    const workersByGroup = [0, 0, 0, 0];
    
    stats.workers.forEach(worker => {
      if (worker.preferredGroup > 0 && worker.preferredGroup <= 4) {
        workersByGroup[worker.preferredGroup - 1]++;
      }
    });
    
    logger('info', `Workers by preferred group: G1:${workersByGroup[0]} G2:${workersByGroup[1]} G3:${workersByGroup[2]} G4:${workersByGroup[3]}`);
    logger('info', `Group switch cooldown: ${this.state.groupSwitchCooldown/1000} seconds`);
    
    const activeWorkers = stats.workers.filter(w => w.active && w.shares > 0);
    if (activeWorkers.length > 0 && activeWorkers.length <= 5) {
      // Only show details for 5 or fewer workers to avoid log spam
      logger('info', 'Active Workers:');
      activeWorkers.forEach(worker => {
        const computorId = this.state.minerComputorAssignments.get(worker.workerKey) || 'None';
        const groupId = worker.computorGroup || 'None';
        const prefGroup = worker.preferredGroup || 'Any';
        logger('info', `  ${worker.workerKey}: ${worker.shares} shares, ${worker.hashrateFormatted}, Computor: ${computorId} (Group ${groupId}, Pref: ${prefGroup})`);
      });
    } else if (activeWorkers.length > 5) {
      // Just show the top 3 workers if there are many
      logger('info', `Active Workers: ${activeWorkers.length} total`);
      activeWorkers.slice(0, 3).forEach(worker => {
        const computorId = this.state.minerComputorAssignments.get(worker.workerKey) || 'None';
        const groupId = worker.computorGroup || 'None';
        const prefGroup = worker.preferredGroup || 'Any';
        logger('info', `  ${worker.workerKey}: ${worker.shares} shares, ${worker.hashrateFormatted}, Computor: ${computorId} (Group ${groupId}, Pref: ${prefGroup})`);
      });
      logger('info', `  ...and ${activeWorkers.length - 3} more`);
    } else {
      logger('info', '  No active workers with shares');
    }
  }
}

class HttpServer {
  constructor(state, statsManager) {
    this.state = state;
    this.statsManager = statsManager;
    this.server = null;
  }
  
  start() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    
    this.server.on('error', (err) => {
      logger('error', `HTTP server error: ${err.message}`);
    });
    
    this.server.listen(CONFIG.statsPort, '0.0.0.0', () => {
      logger('info', `HTTP server listening on port ${CONFIG.statsPort}`);
      logger('info', `Admin UI available at http://localhost:${CONFIG.statsPort}/admin/computors`);
    });
  }
  
  serveAdminHtml() {
    try {
      // Read the HTML file
      let html = fsSync.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
      
      // Replace placeholders with actual values
      html = html.replace(/CURRENT_EPOCH/g, this.state.currentEpoch);
      
      return html;
    } catch (error) {
      logger('error', `Error reading admin.html: ${error.message}`);
      return `
        <html>
          <body>
            <h1>Error</h1>
            <p>Could not load admin interface: ${error.message}</p>
            <p>Please make sure admin.html exists in the same directory as the server.</p>
          </body>
        </html>
      `;
    }
  }
  
  handleRequest(req, res) {
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
    
    // Route handling
    if (req.url === '/update-computor-weight' && req.method === 'POST') {
      this.handleUpdateComputorWeight(req, res);
    }
    else if (req.url === '/computors') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.serveAdminHtml());
    }
    else if (req.url === '/stats' || req.url === '/api/stats') {
      const stats = this.statsManager.generateStats();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats, null, 2));
      
      logger('debug', `Stats served to ${req.socket.remoteAddress}`);
    } 
    else if (req.url === '/computor-list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.state.computorIdentities, null, 2));
    }
    else if (req.url === '/computor-assignments') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const assignments = Array.from(this.state.minerComputorAssignments.entries()).map(([workerKey, computorIndex]) => {
        return { workerKey, computorIndex };
      });
      res.end(JSON.stringify(assignments, null, 2));
    }
    else if (req.url === '/add-computor' && req.method === 'POST') {
      this.handleAddComputor(req, res);
    }
    else if (req.url === '/remove-computor' && req.method === 'POST') {
      this.handleRemoveComputor(req, res);
    }
    else if (req.url === '/reset-computor-assignments' && req.method === 'POST') {
      this.handleResetComputorAssignments(req, res);
    }
    else if (req.url === '/add-identity-batch' && req.method === 'POST') {
      this.handleAddIdentityBatch(req, res);
    }
    else if (req.url === '/fetch-computor-list' && req.method === 'POST') {
      this.handleFetchComputorList(req, res);
    }
    else if (req.url === '/index.html' || req.url === '/admin.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.serveAdminHtml());
    }
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }
  
  async handleUpdateComputorWeight(req, res) {
    try {
      const body = await this.readRequestBody(req);
      const data = JSON.parse(body);
      const index = parseInt(data.index);
      const weight = parseInt(data.weight);
      
      if (isNaN(index) || index < 0 || index >= this.state.computorDistribution.length) {
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
      this.state.computorDistribution[index].weight = weight;
      await this.statsManager.saveComputorDistribution();
      this.state.emit('computorDistributionChanged');
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: `Updated computor index ${this.state.computorDistribution[index].index} weight to ${weight}%` 
      }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid request format' }));
    }
  }
  
  async handleAddComputor(req, res) {
    try {
      const body = await this.readRequestBody(req);
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
      const existingIndex = this.state.computorDistribution.findIndex(item => item.index === newIndex);
      if (existingIndex !== -1) {
        // Update existing entry
        this.state.computorDistribution[existingIndex].weight = weight;
        if (identity) {
          this.state.computorDistribution[existingIndex].identity = identity;
        }
      } else {
        // Add new entry
        this.state.computorDistribution.push({
          index: newIndex,
          weight: weight,
          identity: identity
        });
      }
      
      await this.statsManager.saveComputorDistribution();
      this.state.emit('computorDistributionChanged');
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: `Computor index ${newIndex} added with weight ${weight}%` 
      }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid request format' }));
    }
  }
  
  async handleRemoveComputor(req, res) {
    try {
      const body = await this.readRequestBody(req);
      const data = JSON.parse(body);
      const indexToRemove = parseInt(data.index);
      
      if (isNaN(indexToRemove) || indexToRemove < 0 || indexToRemove >= this.state.computorDistribution.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid index' }));
        return;
      }
      
      this.state.computorDistribution.splice(indexToRemove, 1);
      
      await this.statsManager.saveComputorDistribution();
      this.state.emit('computorDistributionChanged');
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: 'Computor removed successfully' 
      }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid request format' }));
    }
  }
  
  async handleResetComputorAssignments(req, res) {
    this.state.minerComputorAssignments.clear();
    await this.statsManager.saveComputorAssignments();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      success: true, 
      message: 'All computor assignments have been reset' 
    }));
  }
  
  async handleAddIdentityBatch(req, res) {
    try {
      const body = await this.readRequestBody(req);
      const data = JSON.parse(body);
      const identities = data.identities;
      const weight = parseInt(data.weight);
      const targetGroup = parseInt(data.group); // Optional: target specific group (1-4)
      
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
      let byGroup = [0, 0, 0, 0]; // Count for each group
      
      for (const identity of identities) {
        const index = this.findComputorIndex(identity);
        
        if (index !== -1) {
          // Check if this computor is in the target group
          let inTargetGroup = true;
          if (!isNaN(targetGroup) && targetGroup >= 1 && targetGroup <= 4) {
            // Group 1: 0-168, Group 2: 169-337, Group 3: 338-506, Group 4: 507-675
            const groupRanges = [
              [0, 168],
              [169, 337],
              [338, 506],
              [507, 675]
            ];
            const targetRange = groupRanges[targetGroup - 1];
            inTargetGroup = (index >= targetRange[0] && index <= targetRange[1]);
            
            if (!inTargetGroup) {
              notFound.push(`${identity} (not in group ${targetGroup})`);
              continue;
            }
          }
          
          // Determine which group this computor belongs to
          let groupId = 0;
          if (index >= 0 && index <= 168) groupId = 1;
          else if (index >= 169 && index <= 337) groupId = 2;
          else if (index >= 338 && index <= 506) groupId = 3;
          else if (index >= 507 && index <= 675) groupId = 4;
          
          if (groupId > 0) {
            byGroup[groupId - 1]++;
          }
          
          // Check if index already exists in distribution
          const existingIndex = this.state.computorDistribution.findIndex(item => item.index === index);
          if (existingIndex !== -1) {
            // Update existing entry
            this.state.computorDistribution[existingIndex].weight = weight;
            this.state.computorDistribution[existingIndex].identity = identity;
          } else {
            // Add new entry
            this.state.computorDistribution.push({
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
      
      if (added > 0) {
        await this.statsManager.saveComputorDistribution();
        this.state.emit('computorDistributionChanged');
      }
      
      let message = `Added ${added} identities with weight ${weight}%.`;
      if (byGroup.some(count => count > 0)) {
        message += ` Distribution: G1:${byGroup[0]} G2:${byGroup[1]} G3:${byGroup[2]} G4:${byGroup[3]}`;
      }
      
      if (notFound.length > 0) {
        message += ` ${notFound.length} identities not found in current epoch.`;
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: message,
        notFound: notFound,
        byGroup: byGroup
      }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        message: 'Invalid request format: ' + error.message 
      }));
    }
  }
  
  async handleFetchComputorList(req, res) {
    try {
      const body = await this.readRequestBody(req);
      const data = JSON.parse(body);
      const epoch = parseInt(data.epoch);
      
      if (isNaN(epoch) || epoch < 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid epoch number' }));
        return;
      }
      
      const identities = await this.statsManager.fetchComputorList(epoch);
      
      if (identities) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: `Retrieved ${identities.length} computors for epoch ${epoch}`,
          identities: identities
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: false, 
          message: `Failed to fetch computor list for epoch ${epoch}` 
        }));
      }
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid request format' }));
    }
  }
  
  findComputorIndex(identity) {
    if (!this.state.computorIdentities.length) {
      return -1;
    }
    
    return this.state.computorIdentities.findIndex(id => id === identity);
  }
  
  readRequestBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', () => {
        resolve(body);
      });
      
      req.on('error', err => {
        reject(err);
      });
    });
  }
}

// Main application class
class QubicStratumProxy {
  constructor() {
    this.state = new StateManager();
    this.statsManager = new StatisticsManager(this.state);
    this.taskSourceClient = new TaskSourceClient(this.state);
    this.minerServer = new MinerServer(this.state);
    this.shareServer = new ShareDistributionServer(this.state);
    this.httpServer = new HttpServer(this.state, this.statsManager);
    
    this.setupIntervals();
    process.on('SIGINT', () => this.handleShutdown());
    process.on('uncaughtException', this.handleUncaughtException.bind(this));
  }
  
  async start() {
    logger('info', 'Starting Qubic Stratum Proxy');
    
    // Load saved data
    logger('info', 'Loading statistics...');
    await this.statsManager.loadPersistentStats();
    
    logger('info', 'Loading computor settings...');
    await this.statsManager.loadComputorSettings();
    
    logger('info', 'Loading computor assignments...');
    await this.statsManager.loadComputorAssignments();
    
    // Analyze computor distribution
    const groupCounts = this.state.analyzeComputorDistribution();
    
    // Start components
    this.taskSourceClient.connect();
    this.minerServer.start();
    this.shareServer.start();
    this.httpServer.start();
    
    // Fetch initial computor list if needed
    if (this.state.computorIdentities.length === 0) {
      logger('info', `Fetching initial computor list for epoch ${this.state.currentEpoch}...`);
      this.statsManager.fetchComputorList(this.state.currentEpoch);
    }
    
    logger('info', `Qubic Stratum Proxy started successfully, optimized for 676 computors (0-675) in 4 groups`);
    logger('info', `Current computor distribution: G1:${groupCounts[0]} G2:${groupCounts[1]} G3:${groupCounts[2]} G4:${groupCounts[3]}`);
  }
  
  setupIntervals() {
    // Miner keepalive
    setInterval(() => this.state.sendKeepaliveToMiners(), CONFIG.keepaliveInterval);
    
    // Stats saving
    setInterval(() => this.statsManager.saveStatsToFile(), CONFIG.statsInterval);
    
    // Persistent stats saving
    setInterval(() => this.statsManager.savePersistentStats(), CONFIG.persistentStatsInterval);
    
    // Share reset check
    setInterval(() => this.state.checkAndResetShares(), 60000);
    
    // Old job mappings cleanup
    setInterval(() => this.state.cleanupOldJobMappings(), 300000); // Clean up old job mappings every 5 minutes
    
    // Prune share history
    setInterval(() => this.state.pruneShareHistory(), CONFIG.pruneShareHistoryInterval);
    
    // Refresh alias table periodically
    setInterval(() => {
      this.state.aliasNeedsRefresh = true;
    }, CONFIG.aliasTableRefreshInterval);
    
    // Log stats periodically
    setInterval(() => this.statsManager.logPeriodicStats(), CONFIG.logStatInterval);
    
    // Check inactive miners
    setInterval(() => this.checkInactiveMiners(), 30000);
    
    // Health check
    setInterval(() => this.logHealthCheck(), CONFIG.logHealthInterval);
  }
  
  checkInactiveMiners() {
    const now = Date.now();
    let inactiveCount = 0;
    
    this.state.miners.forEach((minerInfo, minerId) => {
      if (minerInfo.connected && (now - minerInfo.lastActivity) > CONFIG.keepaliveTimeout) {
        logger('debug', `Disconnecting inactive miner ${minerId} (inactive for ${Math.round((now - minerInfo.lastActivity) / 1000)}s)`);
        if (minerInfo.socket) {
          minerInfo.socket.end();
        }
        minerInfo.connected = false;
        this.state.miners.set(minerId, minerInfo);
        inactiveCount++;
        
        if (minerInfo.workerKey) {
          const workerStat = this.state.workerStats.get(minerInfo.workerKey);
          if (workerStat) {
            workerStat.activeConnections.delete(minerId);
            workerStat.lastSeen = new Date().toISOString();
            this.state.workerStats.set(minerInfo.workerKey, workerStat);
          }
        }
      }
    });
    
    if (inactiveCount > 0) {
      logger('info', `Disconnected ${inactiveCount} inactive miners`);
    }
  }
  
  logHealthCheck() {
    if (this.state.miners.size === 0 && this.shareServer.clients.size === 0) {
      logger('info', `Waiting for connections on miner port ${CONFIG.minerPort}, dashboard port ${CONFIG.statsPort}`);
      logger('info', `Configured with ${this.state.computorDistribution.length} computors for epoch ${this.state.currentEpoch}`);
    }
    
    // Log circuit breaker status
    for (const [service, breaker] of this.state.circuitBreakers.entries()) {
      if (breaker.state !== 'CLOSED') {
        logger('warn', `Circuit breaker for ${service} is ${breaker.state} with ${breaker.failures} failures`);
      }
    }
  }
  
  handleShutdown() {
    logger('info', 'Shutting down...');
    this.statsManager.saveComputorAssignments();
    process.exit(0);
  }
  
  handleUncaughtException(err) {
    logger('error', `Uncaught exception: ${err.message}\n${err.stack}`);
  }
}

// Utility functions
function logger(level, message) {
  const timestamp = new Date().toISOString();
  
  switch(level) {
    case 'error':
      console.error(`[${timestamp}] [ERROR] ${message}`);
      break;
    case 'warn':
      console.warn(`[${timestamp}] [WARN] ${message}`);
      break;
    case 'info':
      console.log(`[${timestamp}] [INFO] ${message}`);
      break;
    case 'debug':
      if (CONFIG.verbose) {
        console.log(`[${timestamp}] [DEBUG] ${message}`);
      }
      break;
    case 'share':
      console.log(`[${timestamp}] [SHARE] ${message}`);
      break;
    case 'job':
      console.log(`[${timestamp}] [JOB] ${message}`);
      break;
    default:
      if (CONFIG.verbose) {
        console.log(`[${timestamp}] ${message}`);
      }
  }
}

function formatHashrate(hashrate) {
  if (hashrate === 0) return '0 H/s';
  
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  const i = Math.floor(Math.log(hashrate) / Math.log(1000));
  
  if (i >= units.length) return `${(hashrate / Math.pow(1000, units.length - 1)).toFixed(2)} ${units[units.length - 1]}`;
  
  return `${(hashrate / Math.pow(1000, i)).toFixed(2)} ${units[i]}`;
}

// Start the proxy
const proxy = new QubicStratumProxy();
proxy.start();

// by jetskipool.ai
