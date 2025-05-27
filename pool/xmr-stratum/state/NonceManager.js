const CONFIG = require('../config/config');
const { logger } = require('../utils/logger');

class NonceManager {
  constructor(stateManager) {
    this.state = stateManager;
    
    // Nonce tracking state
    this.nonceRanges = []; // Array of {start, end, jobId, computorIndex}
    
    // New state for nonce range allocation
    this.computorMinerAssignments = new Map(); // Map of computorIndex -> Set of rigIds
    this.rigIdNonceAssignments = new Map(); // Map of computorIndex -> Map of rigId -> {start, end}
    
    // Enhanced tracking for faster lookups
    this.nonceToJobMap = new Map(); // nonce -> { jobId, computorIndex, rigId }
    this.jobNonceAssignments = new Map(); // jobId -> Map(rigId -> nonceInfo)
  }
  
  // Add a nonce range
  addNonceRange(start, end, jobId, computorIndex) {
    this.nonceRanges.push({start, end, jobId, computorIndex});
    // Keep ranges sorted by start value for binary search efficiency
    this.nonceRanges.sort((a, b) => a.start - b.start);
  }
  
  // Find job for a given nonce
  findJobForNonce(nonce) {
    const nonceNum = typeof nonce === 'string' ? parseInt(nonce) : nonce;
    
    // First check direct nonce mapping for faster lookup
    const directMapping = this.nonceToJobMap.get(nonceNum);
    if (directMapping) {
      return {
        jobId: directMapping.jobId,
        computorIndex: directMapping.computorIndex,
        rigId: directMapping.rigId
      };
    }
    
    // Fallback to binary search for the range containing the nonce - O(log n)
    let left = 0;
    let right = this.nonceRanges.length - 1;
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const range = this.nonceRanges[mid];
      
      if (nonceNum < range.start) {
        right = mid - 1;
      } else if (nonceNum > range.end) {
        left = mid + 1;
      } else {
        return { jobId: range.jobId, computorIndex: range.computorIndex };
      }
    }
    
    return null; // Not found in any range
  }
  
  // MODIFIED: Update cleanupOldJobMappings to handle multiple active jobs
  cleanupOldJobMappings(validJobIds) {
    let cleanedCount = 0;
    
    // Clean nonceRanges
    const originalLength = this.nonceRanges.length;
    this.nonceRanges = this.nonceRanges.filter(range => validJobIds.has(range.jobId));
    cleanedCount = originalLength - this.nonceRanges.length;
    
    // Clean jobNonceAssignments for old jobs
    const jobsToDelete = [];
    for (const jobId of this.jobNonceAssignments.keys()) {
      if (!validJobIds.has(jobId)) {
        jobsToDelete.push(jobId);
      }
    }
    
    for (const jobId of jobsToDelete) {
      this.jobNonceAssignments.delete(jobId);
    }
    
    // Clean nonceToJobMap entries for old jobs
    const noncesToDelete = [];
    for (const [nonce, mapping] of this.nonceToJobMap.entries()) {
      if (!validJobIds.has(mapping.jobId)) {
        noncesToDelete.push(nonce);
      }
    }
    
    for (const nonce of noncesToDelete) {
      this.nonceToJobMap.delete(nonce);
    }
    
    if (cleanedCount > 0 || jobsToDelete.length > 0) {
      logger('debug', `Cleaned up mappings for ${jobsToDelete.length} old jobs and ${cleanedCount} nonce ranges`);
    }
  }
  
  // Allocate nonce range for a rig-id
  allocateNonceRange(jobId, computorIndex, firstComputorIndex, lastComputorIndex, rigId) {
    // Calculate the base nonce range for this computor
    const computorBaseNonce = (computorIndex - firstComputorIndex) * CONFIG.DOMAIN_SIZE;
    
    // Initialize tracking structures if needed
    if (!this.computorMinerAssignments.has(computorIndex)) {
      this.computorMinerAssignments.set(computorIndex, new Set());
    }
    
    if (!this.rigIdNonceAssignments.has(computorIndex)) {
      this.rigIdNonceAssignments.set(computorIndex, new Map());
    }
    
    const minersForComputor = this.computorMinerAssignments.get(computorIndex);
    const nonceAssignmentsForComputor = this.rigIdNonceAssignments.get(computorIndex);
    
    // Generate a random nonce range within the computor's domain
    // No limit on miners per computor - just give each miner a random range
    const randomOffset = Math.floor(Math.random() * (CONFIG.DOMAIN_SIZE - CONFIG.MINER_NONCE_RANGE_SIZE));
    const start_nonce = computorBaseNonce + randomOffset;
    const end_nonce = start_nonce + CONFIG.MINER_NONCE_RANGE_SIZE - 1;
    
    // Create the assignment
    const assignment = { 
      start_nonce, 
      end_nonce, 
      computorIndex,
      jobId,
      firstComputorIndex,
      lastComputorIndex
    };
    
    // Save the assignment (for tracking only)
    minersForComputor.add(rigId);
    nonceAssignmentsForComputor.set(rigId, assignment);
    
    // Store the nonce range mapping for job lookup
    this.addNonceRange(start_nonce, end_nonce, jobId, computorIndex);
    
    // Track job assignments
    if (!this.jobNonceAssignments.has(jobId)) {
      this.jobNonceAssignments.set(jobId, new Map());
    }
    this.jobNonceAssignments.get(jobId).set(rigId, {
      start: start_nonce,
      end: end_nonce,
      timestamp: Date.now(),
      computorIndex,
      firstComputorIndex,
      lastComputorIndex
    });
    
    logger('debug', `Allocated nonce range ${start_nonce}-${end_nonce} for rig-id ${rigId} on computor ${computorIndex}`);
    
    return assignment;
  }
  
  // Clear all nonce assignments (for new job)
  clearAllAssignments() {
    this.computorMinerAssignments.clear();
    this.rigIdNonceAssignments.clear();
    this.nonceToJobMap.clear();
    this.jobNonceAssignments.clear();
    logger('info', 'Cleared all nonce assignments for fresh job distribution');
  }
  
  // NEW: Clear assignments for a specific job only
  clearJobAssignments(jobId) {
    let clearedCount = 0;
    
    // Clear from nonceRanges
    const originalLength = this.nonceRanges.length;
    this.nonceRanges = this.nonceRanges.filter(range => range.jobId !== jobId);
    clearedCount = originalLength - this.nonceRanges.length;
    
    // Clear from jobNonceAssignments
    if (this.jobNonceAssignments.has(jobId)) {
      this.jobNonceAssignments.delete(jobId);
    }
    
    // Clear from nonceToJobMap entries that match this jobId
    const toDelete = [];
    for (const [nonce, mapping] of this.nonceToJobMap.entries()) {
      if (mapping.jobId === jobId) {
        toDelete.push(nonce);
      }
    }
    
    for (const nonce of toDelete) {
      this.nonceToJobMap.delete(nonce);
    }
    
    if (clearedCount > 0) {
      logger('debug', `Cleared ${clearedCount} nonce assignments for job ${jobId}`);
    }
    
    return clearedCount;
  }
  
  // Clean up nonce assignments for inactive miners
  cleanupAssignments(minerManager) {
    // For each computor
    for (const [computorIndex, assignedRigIds] of this.computorMinerAssignments.entries()) {
      // Check each rig-id to see if it has any active miners
      const nonceAssignments = this.rigIdNonceAssignments.get(computorIndex);
      
      if (nonceAssignments) {
        const rigIdsToRemove = [];
        
        for (const rigId of assignedRigIds) {
          // Check if any miners with this rig-id are still active
          const hasActiveMiner = Array.from(minerManager.getAll().values()).some(
            miner => miner.rigId === rigId && miner.connected
          );
          
          if (!hasActiveMiner) {
            rigIdsToRemove.push(rigId);
          }
        }
        
        // Remove assignments for inactive rig-ids
        for (const rigId of rigIdsToRemove) {
          assignedRigIds.delete(rigId);
          nonceAssignments.delete(rigId);
          logger('debug', `Removed nonce assignment for inactive rig-id ${rigId} on computor ${computorIndex}`);
        }
      }
    }
  }
  
  // Cleanup old nonce mappings
  cleanupOldMappings(maxAge = 600000) { // 10 minutes
    const now = Date.now();
    let cleaned = 0;
    
    // Clean direct nonce mappings
    for (const [nonce, mapping] of this.nonceToJobMap.entries()) {
      if (now - mapping.timestamp > maxAge) {
        this.nonceToJobMap.delete(nonce);
        cleaned++;
      }
    }
    
    // Clean job assignments
    for (const [jobId, rigIdAssignments] of this.jobNonceAssignments.entries()) {
      let hasValidAssignments = false;
      
      for (const [rigId, assignment] of rigIdAssignments.entries()) {
        if (now - assignment.timestamp > maxAge) {
          rigIdAssignments.delete(rigId);
        } else {
          hasValidAssignments = true;
        }
      }
      
      if (!hasValidAssignments) {
        this.jobNonceAssignments.delete(jobId);
      }
    }
    
    if (cleaned > 0) {
      logger('debug', `Cleaned ${cleaned} old nonce mappings`);
    }
    
    return cleaned;
  }
  
  // Get assignment stats for reporting
  getAssignmentStats() {
    return {
      totalComputors: this.rigIdNonceAssignments.size,
      totalAssignments: Array.from(this.rigIdNonceAssignments.values())
        .reduce((total, map) => total + map.size, 0),
      directMappings: this.nonceToJobMap.size,
      totalJobs: this.jobNonceAssignments.size,
      assignmentsByComputor: Array.from(this.rigIdNonceAssignments.entries())
        .slice(0, 10) // Limit to top 10 computors
        .map(([computorIndex, assignments]) => {
          return {
            computorIndex,
            totalAssignments: assignments.size,
            // Only include the first 5 assignments to avoid large stats
            assignments: Array.from(assignments.entries())
              .slice(0, 5)
              .map(([rigId, range]) => {
                return {
                  rigId,
                  start_nonce: range.start_nonce,
                  end_nonce: range.end_nonce,
                  slotIndex: range.slotIndex
                };
              })
          };
        })
    };
  }
  
  // Get all assignments (for persistence)
  getAllAssignments() {
    return Array.from(this.rigIdNonceAssignments.entries()).map(([computorIndex, assignments]) => {
      return [
        computorIndex, 
        Array.from(assignments.entries())
      ];
    });
  }
  
  // Load assignments from persistence
  loadAssignments(data) {
    if (!data || !Array.isArray(data)) return;
    
    for (const [computorIndex, assignments] of data) {
      if (!this.rigIdNonceAssignments.has(computorIndex)) {
        this.rigIdNonceAssignments.set(computorIndex, new Map());
      }
      
      if (!this.computorMinerAssignments.has(computorIndex)) {
        this.computorMinerAssignments.set(computorIndex, new Set());
      }
      
      const nonceMap = this.rigIdNonceAssignments.get(computorIndex);
      const minerSet = this.computorMinerAssignments.get(computorIndex);
      
      for (const [rigId, assignment] of assignments) {
        nonceMap.set(rigId, assignment);
        minerSet.add(rigId);
      }
    }
    
    logger('info', `Loaded nonce assignments for ${this.rigIdNonceAssignments.size} computors`);
  }
}

module.exports = NonceManager;
