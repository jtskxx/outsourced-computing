const { logger } = require('../utils/logger');

class MetricsManager {
  constructor(stateManager) {
    this.state = stateManager;
    
    // Performance metrics
    this.metrics = {
      totalSubmittedShares: 0,
      acceptedShares: 0,
      rejectedShares: 0,
      duplicateShares: 0,
      computorLoadVariance: 0,
      shareRatio: {} // Map of computorIndex -> percentage of total shares
    };
  }
  
  // Record a share submission
  recordShare(isDuplicate) {
    this.metrics.totalSubmittedShares++;
    
    if (isDuplicate) {
      this.metrics.duplicateShares++;
    } else {
      this.metrics.acceptedShares++;
    }
    
    // Log metrics state for debugging
    if (require('../config/config').verbose) {
      logger('debug', `MetricsManager.recordShare: accepted=${this.metrics.acceptedShares}, duplicates=${this.metrics.duplicateShares}, total=${this.metrics.totalSubmittedShares}`);
    }
  }
  
  // Record a rejected share
  recordRejectedShare() {
    this.metrics.rejectedShares++;
  }
  
  // Update computor load metrics
  updateComputorLoadMetrics(shareRatio, variance) {
    this.metrics.shareRatio = shareRatio;
    this.metrics.computorLoadVariance = variance;
  }
  
  // Get all metrics
  getMetrics() {
    return {
      ...this.metrics,
      acceptRate: this.metrics.totalSubmittedShares > 0 
        ? (this.metrics.acceptedShares / this.metrics.totalSubmittedShares * 100).toFixed(2) 
        : 0,
      duplicates: this.metrics.duplicateShares,
      totalAcceptedIncludingDuplicates: this.metrics.acceptedShares + this.metrics.duplicateShares
    };
  }
  
  // Reset metrics
  reset() {
    this.metrics.totalSubmittedShares = 0;
    this.metrics.acceptedShares = 0;
    this.metrics.rejectedShares = 0;
    this.metrics.duplicateShares = 0;
    this.metrics.computorLoadVariance = 0;
    this.metrics.shareRatio = {};
  }
  
  // Load metrics from persistence
  loadMetrics(data) {
    if (data) {
      this.metrics = { ...this.metrics, ...data };
    }
  }
}

module.exports = MetricsManager;
