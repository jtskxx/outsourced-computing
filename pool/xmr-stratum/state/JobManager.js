const CONFIG = require('../config/config');
const { logger } = require('../utils/logger');

class JobManager {
  constructor(stateManager) {
    this.state = stateManager;
    
    // Cache for recent jobs
    this.recentJobs = new Map();
    this.maxJobCacheSize = CONFIG.maxJobCacheSize || 50;
  }
  

  storeRecentJob(job) {
    if (!job || !job.job || !job.job.job_id) return;
    
    const jobId = job.job.job_id;
    const timestamp = Date.now();
    

    if (this.recentJobs.has(jobId)) {
      const existing = this.recentJobs.get(jobId);
      existing.timestamp = timestamp;
      return;
    }
    

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
      id: job.id,
      timestamp,
      receivedAt: new Date().toISOString()
    };
    
    this.recentJobs.set(jobId, newJob);
    
    // Cache valid computors for performance
    const rangeKey = `${job.job.first_computor_index}-${job.job.last_computor_index}`;
    const validComputors = this.state.computors.getDistribution().filter(
      item => item.index >= job.job.first_computor_index && 
             item.index <= job.job.last_computor_index
    );
    

    if (this.state.computors.validComputorsCache && !this.state.computors.validComputorsCache.has(rangeKey)) {
      this.state.computors.validComputorsCache.set(rangeKey, validComputors);
    }
    

    if (this.recentJobs.size > this.maxJobCacheSize) {
      // Remove oldest
      const firstKey = this.recentJobs.keys().next().value;
      this.recentJobs.delete(firstKey);
      

      this.cleanupOldJobMappings();
    }
    
    logger('debug', `Stored job ${jobId} in cache, cache size: ${this.recentJobs.size}`);
  }
  

  getJob(jobId) {
    const cachedJob = this.recentJobs.get(jobId);
    return cachedJob ? cachedJob : null;
  }
  

  hasJob(jobId) {
    return this.recentJobs.has(jobId);
  }
  

  getJobStats() {
    const stats = {
      cacheSize: this.recentJobs.size,
      maxCacheSize: this.maxJobCacheSize,
      jobs: []
    };
    
    for (const [jobId, jobData] of this.recentJobs.entries()) {
      stats.jobs.push({
        jobId,
        age: Date.now() - jobData.timestamp,
        receivedAt: jobData.receivedAt
      });
    }
    
    return stats;
  }
  

  getValidJobIds() {
    return new Set(this.recentJobs.keys());
  }
  

  cleanupOldJobMappings() {
    const validJobIds = this.getValidJobIds();
    if (this.state.nonces.cleanupOldJobMappings) {
      this.state.nonces.cleanupOldJobMappings(validJobIds);
    }
  }
  

  clear() {
    const size = this.recentJobs.size;
    this.recentJobs.clear();
    logger('debug', `Cleared job cache (had ${size} jobs)`);
  }
  

  clearCache() {
    this.clear();
  }
  

  pruneOldJobs(maxAge = 600000) { // 10 min default
    const now = Date.now();
    let pruned = 0;
    
    for (const [jobId, jobData] of this.recentJobs.entries()) {
      if (now - jobData.timestamp > maxAge) {
        this.recentJobs.delete(jobId);
        pruned++;
      }
    }
    
    if (pruned > 0) {
      logger('debug', `Pruned ${pruned} old jobs from cache`);
    }
    
    return pruned;
  }
}

module.exports = JobManager;
