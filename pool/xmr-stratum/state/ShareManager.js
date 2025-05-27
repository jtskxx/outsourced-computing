const CONFIG = require('../config/config');
const { logger } = require('../utils/logger');

class ShareManager {
  constructor(stateManager) {
    this.state = stateManager;
    
    // Duplicate share detection
    this.recentShares = new Map(); // Map of "nonce:jobId" -> timestamp
  }
  
  // Check if a share is a duplicate
  isDuplicateShare(nonce, jobId) {
    const shareKey = `${nonce}:${jobId}`;
    return this.recentShares.has(shareKey);
  }
  
  // Record a share to detect duplicates
  recordShare(nonce, jobId) {
    const shareKey = `${nonce}:${jobId}`;
    const isDuplicate = this.recentShares.has(shareKey);
    
    // Record even if duplicate for accurate metrics
    this.recentShares.set(shareKey, Date.now());
    
    // Update metrics
    this.state.metrics.recordShare(isDuplicate);
    
    return isDuplicate;
  }
  
  // Prune old share history
  pruneHistory() {
    const cutoffTime = Date.now() - CONFIG.hashrateWindow;
    let totalPruned = 0;
    
    // Prune worker share history
    this.state.miners.getAllWorkerStats().forEach((workerStat, workerKey) => {
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
    
    // Also prune duplicate share detection cache
    const shareCutoffTime = Date.now() - CONFIG.duplicateShareWindow;
    let prunedShares = 0;
    
    for (const [shareKey, timestamp] of this.recentShares.entries()) {
      if (timestamp < shareCutoffTime) {
        this.recentShares.delete(shareKey);
        prunedShares++;
      }
    }
    
    if ((totalPruned > 0 || prunedShares > 0) && CONFIG.verbose) {
      logger('debug', `Pruned ${totalPruned} share history entries and ${prunedShares} duplicate share records`);
    }
  }
  
  // Calculate hashrate for a worker
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
  
  // Reset all share counts
  resetAll() {
    let resetCount = 0;
    
    this.state.miners.getAllWorkerStats().forEach((workerStat, workerKey) => {
      if (workerStat.shares > 0) {
        resetCount++;
        workerStat.shares = 0;
        workerStat.shareHistory = [];
      }
    });
    
    // Clear duplicate share tracking
    this.recentShares.clear();
    
    return resetCount;
  }
  
  // Clear duplicate share cache
  clearDuplicateCache() {
    this.recentShares.clear();
  }
}

module.exports = ShareManager;
