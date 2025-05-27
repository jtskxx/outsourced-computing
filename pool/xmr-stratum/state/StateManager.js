const EventEmitter = require('events');
const CONFIG = require('../config/config');
const MinerManager = require('./MinerManager');
const ComputorManager = require('./ComputorManager');
const NonceManager = require('./NonceManager');
const ShareManager = require('./ShareManager');
const JobManager = require('./JobManager');
const MetricsManager = require('./MetricsManager');
const { logger } = require('../utils/logger');

// Global state managed by StateManager
class StateManager extends EventEmitter {
  constructor() {
    super();
    
    // Initialize all sub-managers
    this.miners = new MinerManager(this);
    this.computors = new ComputorManager(this);
    this.nonces = new NonceManager(this);
    this.shares = new ShareManager(this);
    this.jobs = new JobManager(this);
    this.metrics = new MetricsManager(this);
    
    // PostgreSQL manager will be injected later
    this.postgresql = null;
    
    // Global state
    this.totalShares = 0;
    this.lastShareReset = null;
    
    // CHANGED: Support multiple active jobs instead of single currentJob
    this.activeJobs = new Map(); // job_id -> job data
    this.maxActiveJobs = CONFIG.maxActiveJobs || 10; // Limit active jobs
    this.lastJobId = null;
    
    // Keep currentJob for backward compatibility
    this.currentJob = null;
    
    // Task processing statistics
    this.taskStats = {
      processed: 0,
      skipped: 0,
      mined: 0,
      lastProcessed: null,
      processingTimes: [], // Last 100 processing times in ms
      activeJobCount: 0 // NEW: Track active jobs
    };
    
    // Share reconciliation tracking
    this.shareTracking = {
      totalSubmitted: 0,
      totalAccepted: 0,
      totalDistributed: 0,
      missingJobShares: 0
    };
    
    // Circuit breaker state
    this.circuitBreakers = new Map();
    
    // Connection rate tracking
    this.connectionRates = new Map(); // IP -> [timestamps]
    
    // Initialize event handlers
    this.initEventHandlers();
  }
  
  initEventHandlers() {
    // Job handling - MODIFIED for parallel processing
    this.on('job', (job) => {
      const jobId = job.job.job_id;
      
      // Add timestamp to job
      job.timestamp = Date.now();
      
      // Add to active jobs instead of overwriting
      this.activeJobs.set(jobId, job);
      this.lastJobId = jobId;
      
      // Keep currentJob updated for backward compatibility
      this.currentJob = job;
      
      // Store the job in recent jobs cache
      this.jobs.storeRecentJob(job);
      
      // Don't clear ALL nonce assignments - only clear for this specific job
      // This allows other jobs to continue mining
      this.nonces.clearJobAssignments(jobId);
      
      // Limit active jobs to prevent memory issues
      if (this.activeJobs.size > this.maxActiveJobs) {
        // Remove oldest jobs
        const sortedJobs = Array.from(this.activeJobs.entries())
          .sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
        
        while (this.activeJobs.size > this.maxActiveJobs) {
          const [oldJobId] = sortedJobs.shift();
          this.activeJobs.delete(oldJobId);
          this.nonces.clearJobAssignments(oldJobId);
          logger('debug', `Removed old active job ${oldJobId} to maintain limit`);
        }
      }
      
      // Update active job count
      this.taskStats.activeJobCount = this.activeJobs.size;
      
      // Count active miners for logging
      const activeMinerCount = this.miners.getActiveCount();
      logger('job', `Processing job ${jobId} with ${activeMinerCount} active miners, ${this.activeJobs.size} active jobs`);
      
      // Broadcast this specific job
      this.emit('broadcastJob', job);
    });
    
    // Share handling - unified counting
    this.on('share', (share) => {
      // This is for successfully distributed shares
      this.totalShares++;
      this.shareTracking.totalDistributed++;
      
      logger('debug', `[StateManager] Share event received, emitting distributionShare`);
      logger('debug', `Share event: totalShares=${this.totalShares}, distributed=${this.shareTracking.totalDistributed}`);
      
      // Note: We no longer track shares per computor since we use random selection
      
      this.emit('distributionShare', share);
    });
    
    // New event for all accepted shares (including those without job info)
    this.on('acceptedShare', (share) => {
      // NOTE: We already increment acceptedShares in MetricsManager.recordShare()
      // so we only track the detailed info here, not the count
      this.shareTracking.totalAccepted++;
      
      // Note: We no longer track shares per computor since we use random selection
    });
    
    // Computor distribution changes
    this.on('computorDistributionChanged', () => {
      this.computors.onDistributionChanged();
      logger('info', 'Computor distribution changed, refreshed caches');
    });
  }
  
  // NEW: Get an active job that has valid computors for a miner
  getActiveJobForMiner(minerInfo) {
    // Try to find a job with valid computors for this miner
    for (const [jobId, job] of this.activeJobs) {
      const computorIndex = this.computors.getNextComputorIndex(
        job.job.first_computor_index,
        job.job.last_computor_index,
        minerInfo.workerKey
      );
      
      if (computorIndex !== null) {
        return job;
      }
    }
    
    return null; // No valid job found
  }
  
  // NEW: Get active job by ID
  getActiveJob(jobId) {
    return this.activeJobs.get(jobId);
  }
  
  // NEW: Check if job is active
  hasActiveJob(jobId) {
    return this.activeJobs.has(jobId);
  }
  
  // NEW: Clean up completed or old jobs
  cleanupActiveJobs() {
    const now = Date.now();
    const maxJobAge = CONFIG.maxJobAge || 600000; // 10 minutes default
    
    let removedCount = 0;
    for (const [jobId, job] of this.activeJobs) {
      if (job.timestamp && (now - job.timestamp) > maxJobAge) {
        this.activeJobs.delete(jobId);
        this.nonces.clearJobAssignments(jobId);
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      logger('debug', `Cleaned up ${removedCount} old active jobs`);
      this.taskStats.activeJobCount = this.activeJobs.size;
    }
  }
  
  // Circuit breaker implementation
  getCircuitBreaker(service) {
    const CONFIG = require('../config/config');
    
    if (!this.circuitBreakers.has(service)) {
      this.circuitBreakers.set(service, {
        failures: 0,
        lastFailure: 0,
        state: 'CLOSED' // CLOSED, OPEN, HALF_OPEN
      });
    }
    return this.circuitBreakers.get(service);
  }
  
  recordFailure(service) {
    const CONFIG = require('../config/config');
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
  
  // Connection rate limiting
  isRateLimited(ip) {
    const CONFIG = require('../config/config');
    
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
  
  // Weekly share reset
  checkAndResetShares() {
    const CONFIG = require('../config/config');
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
    
    // Reset shares in all managers
    const resetCount = this.shares.resetAll();
    this.computors.resetShareCounts();
    
    // Reset metrics
    this.metrics.reset();
    
    this.lastShareReset = new Date().toISOString();
    
    logger('info', `Reset ${resetCount} workers, previous total: ${previousTotal} shares`);
  }
  
  // Get worker key utility
  getWorkerKey(wallet, workerName) {
    return `${wallet || 'unknown'}.${workerName || 'default'}`;
  }
  
  // Send keepalive to all miners
  sendKeepaliveToMiners() {
    this.miners.updateAllLastActivity();
  }
  
  // Cleanup stale connections and data
  cleanup() {
    // Clean up stale miners
    const removedMiners = this.miners.cleanupStale();
    
    // Clean up old active jobs
    this.cleanupActiveJobs();
    
    // Prune share history
    this.shares.pruneHistory();
    
    // Prune old jobs from cache
    this.jobs.pruneOldJobs();
    
    // Cleanup old nonce mappings
    this.nonces.cleanupOldMappings();
    
    // Check for redistribution of load if needed (clears assignments periodically)
    this.computors.rebalanceLoadIfNeeded();
  }
}

module.exports = StateManager;