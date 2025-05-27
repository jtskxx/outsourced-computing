const fsSync = require('fs');
const CONFIG = require('../config/config');
const FileHelper = require('../utils/FileHelper');
const NetworkHelper = require('../utils/NetworkHelper');
const { logger, formatHashrate } = require('../utils/logger');

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
      workers: Array.from(this.state.miners.getAllWorkerStats().entries()).map(([key, data]) => {
        const cleanedData = JSON.parse(JSON.stringify(data));
        
        // Keep rig-id when persisting stats
        if (!cleanedData.rigId && cleanedData.workerName) {
          cleanedData.rigId = cleanedData.workerName;
        }
        
        // Remove fields we don't want to persist
        delete cleanedData.firstSeen;
        delete cleanedData.totalConnections;
        delete cleanedData.activeConnections;
        
        return [key, cleanedData];
      }),
      // Also save nonce assignments for rig-ids
      rigIdNonceAssignments: this.state.nonces.getAllAssignments(),
      // Save computor share counts for load balancing
      computorShareCounts: Array.from(this.state.computors.computorShareCounts.entries()),
      // Save performance metrics
      metrics: this.state.metrics.getMetrics(),
      // Save share tracking
      shareTracking: this.state.shareTracking,
      savedAt: new Date().toISOString()
    };
    
    await FileHelper.saveJSON(CONFIG.persistentStatsPath, persistentData);
    
    // Also save computor assignments
    await this.saveComputorAssignments();
    
    // Save enabled computors
    await this.saveEnabledComputors();
  }
  
  async saveComputorAssignments() {
    const assignmentsData = Array.from(this.state.computors.minerComputorAssignments.entries());
    await FileHelper.saveJSON(CONFIG.computorAssignmentsPath, assignmentsData);
  }
  
  async saveComputorDistribution() {
    try {
      // Order computors by index for better organization
      const distribution = this.state.computors.getDistribution();
      distribution.sort((a, b) => a.index - b.index);
      
      // Save distribution
      await FileHelper.saveJSON(CONFIG.computorIndexesPath, distribution);
      
      // Clear cache after saving
      if (this.state.computors.validComputorsCache) {
        this.state.computors.validComputorsCache.clear();
      }
      
      // Update load metrics
      this.state.computors.updateLoadMetrics();
      
      logger('debug', `Computor distribution saved with ${distribution.length} computors`);
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
            
            // Ensure rig-id is set, defaulting to worker name if needed
            if (!data.rigId && data.workerName) {
              data.rigId = data.workerName;
            }
            
            data.activeConnections = new Set();
            // Ensure shareHistory is an array
            if (!data.shareHistory || !Array.isArray(data.shareHistory)) {
              data.shareHistory = [];
            }
            this.state.miners.workerStats.set(key, data);
          }
        }
        
        // Load nonce assignments for rig-ids if available
        if (persistentData.rigIdNonceAssignments && Array.isArray(persistentData.rigIdNonceAssignments)) {
          this.state.nonces.loadAssignments(persistentData.rigIdNonceAssignments);
        }
        
        // Load computor share counts for load balancing
        if (persistentData.computorShareCounts && Array.isArray(persistentData.computorShareCounts)) {
          for (const [computorIndex, count] of persistentData.computorShareCounts) {
            this.state.computors.computorShareCounts.set(computorIndex, count);
          }
          
          // Update load metrics
          this.state.computors.updateLoadMetrics();
        }
        
        // Load performance metrics
        if (persistentData.metrics) {
          this.state.metrics.loadMetrics(persistentData.metrics);
          logger('info', `Loaded metrics: accepted=${persistentData.metrics.acceptedShares || 0}, duplicates=${persistentData.metrics.duplicateShares || 0}, totalSubmitted=${persistentData.metrics.totalSubmittedShares || 0}`);
        }
        
        // Load share tracking
        if (persistentData.shareTracking) {
          this.state.shareTracking = persistentData.shareTracking;
          logger('info', `Loaded share tracking: submitted=${persistentData.shareTracking.totalSubmitted}, accepted=${persistentData.shareTracking.totalAccepted}, distributed=${persistentData.shareTracking.totalDistributed}`);
        }
        
        logger('info', `Loaded stats: ${this.state.miners.workerStats.size} workers, distributed shares: ${this.state.totalShares}`);
        
        // Log comparison of distributed vs accepted
        const loadedMetrics = this.state.metrics.getMetrics();
        const totalAccepted = loadedMetrics.acceptedShares + loadedMetrics.duplicateShares;
        logger('info', `Share counts after load - Distributed: ${this.state.totalShares}, Accepted+Duplicates: ${totalAccepted}, Difference: ${totalAccepted - this.state.totalShares}`);
        
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
            
            // Ensure rig-id is set, defaulting to worker name if needed
            if (!data.rigId && data.workerName) {
              data.rigId = data.workerName;
            }
            
            data.activeConnections = new Set();
            // Ensure shareHistory is an array
            if (!data.shareHistory || !Array.isArray(data.shareHistory)) {
              data.shareHistory = [];
            }
            this.state.miners.workerStats.set(key, data);
          });
        }
        
        // Load nonce assignments if available in persistent data
        if (persistentData.rigIdNonceAssignments && Array.isArray(persistentData.rigIdNonceAssignments)) {
          this.state.nonces.loadAssignments(persistentData.rigIdNonceAssignments);
        }
        
        // Load metrics if available
        if (persistentData.metrics) {
          this.state.metrics.loadMetrics(persistentData.metrics);
          logger('info', `Loaded metrics from sync method`);
        }
        
        // Load share tracking if available
        if (persistentData.shareTracking) {
          this.state.shareTracking = persistentData.shareTracking;
          logger('info', `Loaded share tracking from sync method`);
        }
        
        logger('info', `Loaded stats: ${this.state.miners.workerStats.size} workers, ${this.state.totalShares} shares`);
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
        this.state.computors.setDistribution(distribution);
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
        const distribution = JSON.parse(data);
        this.state.computors.setDistribution(distribution);
        logger('info', `Loaded computor distribution with ${distribution.length} entries`);
      } else {
        // Initialize with default
        this.state.computors.setDistribution([{
          index: 0,
          identity: null
        }]);
        logger('info', `No distribution file found, using default index: 0`);
        this.saveComputorDistribution(); // Save with sync method
      }
    } catch (error) {
      logger('error', `Error loading settings: ${error.message}`);
      // Initialize with default
      this.state.computors.setDistribution([{
        index: 0,
        identity: null
      }]);
      logger('info', `Using default distribution due to error`);
    }
  }
  
  async loadComputorAssignments() {
    try {
      // Try to load with async method first
      const assignmentsData = await FileHelper.loadJSON(CONFIG.computorAssignmentsPath);
      
      if (assignmentsData) {
        // Clear existing assignments
        this.state.computors.clearAssignments();
        
        // Load saved assignments
        for (const [workerKey, computorIndex] of assignmentsData) {
          // Note: We no longer persist assignments since they're random on each job
          // this.state.computors.minerComputorAssignments.set(workerKey, computorIndex);
        }
        
        logger('info', `Loaded ${assignmentsData.length} computor assignments`);
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
        
        // Note: We no longer persist assignments since they're random on each job
        // Just log that we found the file but won't load it
        // this.state.computors.clearAssignments();
        // for (const [workerKey, computorIndex] of assignmentsData) {
        //   this.state.computors.minerComputorAssignments.set(workerKey, computorIndex);
        // }
        
        logger('info', `Loaded ${assignmentsData.length} computor assignments`);
      } else {
        logger('info', `No computor assignments file found`);
      }
    } catch (error) {
      logger('error', `Error loading computor assignments: ${error.message}`);
    }
  }
  
  async saveEnabledComputors(enabledComputors) {
    try {
      const computorsToSave = enabledComputors || Array.from(this.state.computors.enabledComputors);
      await FileHelper.saveJSON(CONFIG.enabledComputorsPath || './enabled_computors.json', computorsToSave);
      logger('debug', `Saved ${computorsToSave.length} enabled computors`);
      return true;
    } catch (error) {
      logger('error', `Error saving enabled computors: ${error.message}`);
      return false;
    }
  }
  
  async loadEnabledComputors() {
    try {
      const enabledComputors = await FileHelper.loadJSON(CONFIG.enabledComputorsPath || './enabled_computors.json');
      
      if (enabledComputors && Array.isArray(enabledComputors)) {
        this.state.computors.setEnabledComputors(enabledComputors);
        logger('info', `Loaded ${enabledComputors.length} enabled computors`);
      }
    } catch (error) {
      logger('debug', `No enabled computors file found or error loading: ${error.message}`);
      // If no file exists, all computors are enabled by default
    }
    
    return true;
  }
  
  generateStats() {
    const stats = {
      totalShares: this.state.totalShares, // Distributed shares
      lastShareReset: this.state.lastShareReset,
      // Show total valid shares (accepted + duplicates) since we distribute all
      acceptedShares: (this.state.metrics && this.state.metrics.getMetrics()) 
        ? (this.state.metrics.getMetrics().acceptedShares + this.state.metrics.getMetrics().duplicateShares) 
        : 0,
      computorDistribution: this.state.computors.getDistribution(),
      currentEpoch: this.state.computors.currentEpoch,
      minerCount: {
        total: this.state.miners.getTotalCount(),
        active: this.state.miners.getActiveCount()
      },
      // Add rig-id count to stats
      rigIdCount: this.state.miners.getRigIdCount(),
      workers: [],
      currentTime: new Date().toISOString(),
      uptime: process.uptime(),
      
      // Add task processing statistics
      taskStats: {
        processed: this.state.taskStats.processed,
        skipped: this.state.taskStats.skipped,
        mined: this.state.taskStats.mined,
        lastProcessed: this.state.taskStats.lastProcessed,
        avgProcessingTime: this.state.taskStats.processingTimes.length > 0 
          ? this.state.taskStats.processingTimes.reduce((a, b) => a + b, 0) / this.state.taskStats.processingTimes.length 
          : 0
      },
      
      // Add computor load statistics
      computorLoadStats: this.state.computors.getLoadStats(),
      
      // Add share metrics
      shareMetrics: this.state.metrics.getMetrics(),
        
      // Add rig-id information to stats
      rigIds: this.state.miners.getRigIdStats(),
      
      // Add nonce assignments stats
      nonceAssignments: this.state.nonces.getAssignmentStats(),
      
      // Add detailed share tracking
      shareTracking: this.state.shareTracking || {
        totalSubmitted: 0,
        totalAccepted: 0,
        totalDistributed: 0,
        missingJobShares: 0
      },
      
      // Add job cache stats
      jobCacheStats: this.state.jobs.getJobStats(),
      
      // Add active jobs stats for parallel processing
      activeJobs: {
        count: this.state.activeJobs ? this.state.activeJobs.size : 0,
        maxActive: CONFIG.maxActiveJobs || 10,
        jobs: this.state.activeJobs ? Array.from(this.state.activeJobs.keys()).slice(0, 10) : [] // Show first 10 job IDs
      }
    };
    
    let totalHashrate = 0;
    
    this.state.miners.getAllWorkerStats().forEach((workerStat, workerKey) => {
      const hashrate = this.state.shares.calculateHashrate(workerStat.shareHistory);
      totalHashrate += hashrate;
      
      const isActive = workerStat.activeConnections && workerStat.activeConnections.size > 0;
      const assignedComputor = this.state.computors.getCurrentAssignment(workerKey) || null;
      
      stats.workers.push({
        workerKey,
        wallet: workerStat.wallet,
        workerName: workerStat.workerName,
        // Include rig-id in worker stats
        rigId: workerStat.rigId || workerStat.workerName,
        shares: workerStat.shares,
        active: isActive,
        lastSeen: workerStat.lastSeen,
        hashrate,
        hashrateFormatted: formatHashrate(hashrate),
        assignedComputor
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
          this.state.computors.computorIdentities = result.computors.identities;
          this.state.computors.currentEpoch = epoch;
          logger('info', `Loaded ${this.state.computors.computorIdentities.length} computor identities for epoch ${epoch}`);
          
          // Update existing distribution with identity information
          const distribution = this.state.computors.getDistribution();
          const updatedDistribution = distribution.map(item => {
            if (item.index >= 0 && item.index < this.state.computors.computorIdentities.length) {
              item.identity = this.state.computors.computorIdentities[item.index];
            }
            return item;
          });
          
          this.state.computors.setDistribution(updatedDistribution);
          this.state.emit('computorDistributionChanged');
          await this.saveComputorDistribution();
          this.state.recordSuccess('computorApi');
          return this.state.computors.computorIdentities;
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
    
    logger('info', '=== Mining Status ===');
    
    // Show both share counts with clear labels
    logger('info', `Distributed Shares: ${stats.totalShares} | Valid Shares: ${stats.acceptedShares} | Hashrate: ${stats.totalHashrateFormatted}`);
    
    // Show share metrics
    if (stats.shareMetrics) {
      const duplicatePercent = stats.shareMetrics.totalSubmittedShares > 0 
        ? ((stats.shareMetrics.duplicateShares / stats.shareMetrics.totalSubmittedShares) * 100).toFixed(1) 
        : 0;
      logger('info', `Share Analysis: ${stats.shareMetrics.duplicateShares} duplicates (${duplicatePercent}%) - all distributed`);
    }
    
    // Log share tracking comparison
    if (stats.shareMetrics && stats.shareTracking) {
      logger('info', `Share tracking check - MetricsManager: accepted=${stats.shareMetrics.acceptedShares}, ShareTracking: accepted=${stats.shareTracking.totalAccepted}`);
    }
    
    logger('info', `Active Miners: ${stats.minerCount.active}/${stats.minerCount.total} | Computors: ${stats.computorDistribution.length} | Active Jobs: ${stats.activeJobs.count}`);
    
    // Log rig-id information
    logger('info', `Unique Rig-IDs: ${stats.rigIdCount}`);
    
    // Log nonce assignment stats
    if (stats.nonceAssignments) {
      logger('info', `Nonce Assignments: ${stats.nonceAssignments.totalAssignments} across ${stats.nonceAssignments.totalComputors} computors`);
    }
    
    // Log task processing summary
    if (stats.taskStats) {
      logger('info', `Tasks: Processed: ${stats.taskStats.processed} | Mined: ${stats.taskStats.mined} | Skipped: ${stats.taskStats.skipped}`);
    }
    
    // Log share metrics
    if (stats.shareMetrics) {
      logger('info', `Share Metrics: Duplicates: ${stats.shareMetrics.duplicates} | Acceptance Rate: ${stats.shareMetrics.acceptRate}%`);
    }
    
    // Log computor load distribution
    if (stats.computorLoadStats && stats.computorLoadStats.topComputors) {
      const loadVariance = this.state.metrics.getMetrics().computorLoadVariance.toFixed(4);
      logger('info', `Computor load variance: ${loadVariance} (Note: Share tracking may be inaccurate)`);
      
      if (stats.computorLoadStats.topComputors.length > 0) {
        const topComputor = stats.computorLoadStats.topComputors[0];
        logger('info', `Top computor: ${topComputor.computorIndex} (Est. ${topComputor.shares} shares, ${topComputor.assignedMiners} miners)`);
      }
    }
    
    // Log job cache stats if relevant
    if (stats.jobCacheStats) {
      logger('info', `Job Cache: ${stats.jobCacheStats.cacheSize}/${stats.jobCacheStats.maxCacheSize} jobs cached`);
    }
    
    // Log active jobs information
    if (stats.activeJobs && stats.activeJobs.count > 0) {
      logger('info', `Parallel Jobs: ${stats.activeJobs.count} active (max: ${stats.activeJobs.maxActive})`);
      if (stats.activeJobs.count > 1) {
        logger('info', `Active Job IDs: ${stats.activeJobs.jobs.slice(0, 5).join(', ')}${stats.activeJobs.count > 5 ? '...' : ''}`);
      }
    }
    
    // Only show top workers up to the threshold
    const activeWorkers = stats.workers.filter(w => w.active && w.shares > 0);
    const topWorkers = activeWorkers.slice(0, CONFIG.logMinersThreshold);
    
    if (topWorkers.length > 0) {
      logger('info', `Top ${Math.min(CONFIG.logMinersThreshold, activeWorkers.length)} workers (of ${activeWorkers.length} total):`);
      topWorkers.forEach(worker => {
        const computorId = this.state.computors.getCurrentAssignment(worker.workerKey) || 'None';
        logger('info', `  ${worker.workerKey} (${worker.rigId}): ${worker.shares} shares, ${worker.hashrateFormatted}, Computor: ${computorId}`);
      });
    }
  }
}

module.exports = StatisticsManager;
