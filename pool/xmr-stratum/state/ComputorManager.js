const CONFIG = require('../config/config');
const { logger } = require('../utils/logger');

class ComputorManager {
  constructor(stateManager) {
    this.state = stateManager;
    
    // Multi-computor state
    this.computorDistribution = []; // Array of {index, identity}
    this.computorIdentities = []; // Array of identities from the API
    this.currentEpoch = CONFIG.defaultEpoch;
    
    // Track current computor assignments for statistics only (not used for selection)
    this.minerComputorAssignments = new Map(); // Map of workerKey -> computorIndex
    
    // Optimization: Add cache for computors by range
    this.validComputorsCache = new Map(); // Cache for valid computors per range
    
    // Computor load tracking (kept for statistics display only - not used for selection)
    this.computorShareCounts = new Map(); // Track share counts per computor (may be inaccurate)
    this.lastRebalanceTime = Date.now();
    
    // Enabled computors (all enabled by default)
    this.enabledComputors = new Set();
  }
  
  // Get computor distribution
  getDistribution() {
    return this.computorDistribution;
  }
  
  // Set computor distribution
  setDistribution(distribution) {
    this.computorDistribution = distribution;
    this.validComputorsCache.clear();
  }
  
  // Get current assignment for a worker (for statistics only)
  getCurrentAssignment(workerKey) {
    return this.minerComputorAssignments.get(workerKey);
  }
  
  // Clear all assignments
  clearAssignments() {
    this.minerComputorAssignments.clear();
  }
  
  // Record a share for a computor
  recordShare(computorIndex) {
    const currentCount = this.computorShareCounts.get(computorIndex) || 0;
    this.computorShareCounts.set(computorIndex, currentCount + 1);
  }
  
  // Get share count for a computor
  getShareCount(computorIndex) {
    return this.computorShareCounts.get(computorIndex) || 0;
  }
  
  // Reset share counts
  resetShareCounts() {
    this.computorShareCounts.clear();
  }
  
  // Clean up assignments outside valid range (for statistics accuracy)
  cleanupInvalidAssignments(firstComputorIndex, lastComputorIndex) {
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
  
  // Simple random selection - selects a random computor
  getRandomComputor(computors) {
    if (!computors || computors.length === 0) return null;
    if (computors.length === 1) return computors[0].index;
    
    // Pure random selection
    const randomIndex = Math.floor(Math.random() * computors.length);
    const selectedComputor = computors[randomIndex].index;
    
    logger('debug', `Randomly selected computor ${selectedComputor}`);
    return selectedComputor;
  }
  
  // Set enabled computors
  setEnabledComputors(computorIndexes) {
    this.enabledComputors = new Set(computorIndexes);
    logger('info', `Updated enabled computors: ${Array.from(this.enabledComputors).join(', ')}`);
  }
  
  // Check if computor is enabled
  isComputorEnabled(index) {
    // If no specific computors are set, all are enabled
    if (this.enabledComputors.size === 0) return true;
    return this.enabledComputors.has(index);
  }
  
  // Get next computor index - always returns a random selection
  getNextComputorIndex(firstComputorIndex, lastComputorIndex, workerKey = null) {
    if (this.computorDistribution.length === 0) {
      logger('warn', `No computors configured, cannot select a computor index`);
      return null;
    }
    
    // Optimization: Cache valid computors for frequently used ranges
    const rangeKey = `${firstComputorIndex}-${lastComputorIndex}`;
    
    // Use cached computors for this range if available
    let validComputors;
    if (this.validComputorsCache.has(rangeKey)) {
      validComputors = this.validComputorsCache.get(rangeKey);
    } else {
      // Filter to valid computors in range and enabled
      validComputors = this.computorDistribution.filter(
        item => item.index >= firstComputorIndex && 
                item.index <= lastComputorIndex &&
                this.isComputorEnabled(item.index)
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
    
    // Always select a random computor for each job
    const selectedIndex = this.getRandomComputor(validComputors);
    
    if (selectedIndex !== null) {
      // Track the assignment for statistics only (not used for future selections)
      if (workerKey) {
        this.minerComputorAssignments.set(workerKey, selectedIndex);
        if (CONFIG.verbose) {
          logger('debug', `Randomly selected computor ${selectedIndex} for ${workerKey}`);
        }
      }
    }
    
    return selectedIndex;
  }
  
  // Update load metrics
  updateLoadMetrics() {
    if (this.computorShareCounts.size === 0) return;
    
    // Calculate total shares
    const totalShares = Array.from(this.computorShareCounts.values())
      .reduce((sum, count) => sum + count, 0);
    
    if (totalShares === 0) return;
    
    // Calculate share ratios for each computor
    const shareRatio = {};
    let values = [];
    
    for (const [computorIndex, count] of this.computorShareCounts.entries()) {
      const ratio = count / totalShares;
      shareRatio[computorIndex] = ratio;
      values.push(ratio);
    }
    
    // Calculate variance (measure of imbalance)
    let variance = 0;
    if (values.length > 1) {
      const mean = totalShares / values.length;
      variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    }
    
    // Update metrics in metrics manager
    this.state.metrics.updateComputorLoadMetrics(shareRatio, variance);
  }
  
  // Rebalance method simplified - with pure random selection, no rebalancing needed
  rebalanceLoadIfNeeded() {
    // With pure random selection on each job, no rebalancing is needed
    // This method is kept for compatibility but does nothing
    return;
  }
  
  // Handle distribution change
  onDistributionChanged() {
    this.validComputorsCache.clear();
    this.updateLoadMetrics();
  }
  
  // Get load stats for reporting
  getLoadStats() {
    const totalShares = Array.from(this.computorShareCounts.values()).reduce((sum, count) => sum + count, 0);
    
    // Count miners currently assigned to each computor
    const minerCounts = new Map();
    for (const [workerKey, computorIndex] of this.minerComputorAssignments.entries()) {
      minerCounts.set(computorIndex, (minerCounts.get(computorIndex) || 0) + 1);
    }
    
    // Create a comprehensive list of all configured computors with their stats
    const allComputors = [];
    
    // Add all configured computors
    for (const comp of this.computorDistribution) {
      allComputors.push({
        computorIndex: comp.index,
        shares: this.computorShareCounts.get(comp.index) || 0,
        assignedMiners: minerCounts.get(comp.index) || 0
      });
    }
    
    // Sort by miner count (descending), then by index
    allComputors.sort((a, b) => {
      if (b.assignedMiners !== a.assignedMiners) {
        return b.assignedMiners - a.assignedMiners;
      }
      return a.computorIndex - b.computorIndex;
    });
    
    return {
      totalComputors: this.computorDistribution.length,
      totalShares: totalShares,
      minLoad: Math.min(...(Array.from(this.computorShareCounts.values()).length > 0 
        ? Array.from(this.computorShareCounts.values()) 
        : [0])),
      maxLoad: Math.max(...(Array.from(this.computorShareCounts.values()).length > 0 
        ? Array.from(this.computorShareCounts.values()) 
        : [0])),
      topComputors: allComputors
    };
  }
}

module.exports = ComputorManager;
