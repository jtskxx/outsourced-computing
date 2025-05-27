const CONFIG = require('../config/config');
const { logger } = require('../utils/logger');

class MinerManager {
  constructor(stateManager) {
    this.state = stateManager;
    this.miners = new Map();
    this.workerStats = new Map();
    

    this.rigIdIndex = new Map(); // rigId -> minerIds
  }
  

  get(minerId) {
    return this.miners.get(minerId);
  }
  

  has(minerId) {
    return this.miners.has(minerId);
  }
  

  getTotalCount() {
    return this.miners.size;
  }
  

  getActiveCount() {
    return Array.from(this.miners.values()).filter(m => m.connected).length;
  }
  

  getAll() {
    return this.miners;
  }
  

  forEach(callback) {
    this.miners.forEach(callback);
  }
  

  updateMiner(minerId, minerInfo) {
    // Update rig index
    const oldMinerInfo = this.miners.get(minerId);
    if (oldMinerInfo && oldMinerInfo.rigId) {
      const rigIdSet = this.rigIdIndex.get(oldMinerInfo.rigId);
      if (rigIdSet) {
        rigIdSet.delete(minerId);
        if (rigIdSet.size === 0) {
          this.rigIdIndex.delete(oldMinerInfo.rigId);
        }
      }
    }
    

    if (minerInfo.rigId) {
      if (!this.rigIdIndex.has(minerInfo.rigId)) {
        this.rigIdIndex.set(minerInfo.rigId, new Set());
      }
      this.rigIdIndex.get(minerInfo.rigId).add(minerId);
    }
    

    this.miners.set(minerId, minerInfo);
  }
  

  removeMiner(minerId) {
    const minerInfo = this.miners.get(minerId);
    if (minerInfo) {

      if (minerInfo.rigId) {
        const rigIdSet = this.rigIdIndex.get(minerInfo.rigId);
        if (rigIdSet) {
          rigIdSet.delete(minerId);
          if (rigIdSet.size === 0) {
            this.rigIdIndex.delete(minerInfo.rigId);
          }
        }
      }
      
      this.miners.delete(minerId);
    }
  }
  

  getMinersbyRigId(rigId) {
    if (!this.rigIdIndex.has(rigId)) {
      return [];
    }
    
    const minerIds = this.rigIdIndex.get(rigId);
    return Array.from(minerIds).map(minerId => {
      const minerInfo = this.miners.get(minerId);
      return {
        minerId,
        wallet: minerInfo.wallet,
        workerName: minerInfo.workerName,
        workerKey: minerInfo.workerKey,
        rigId: minerInfo.rigId,
        connected: minerInfo.connected,
        shares: minerInfo.shares,
        lastSeen: minerInfo.lastSeen,
        nonceRange: minerInfo.nonceRange
      };
    }).filter(m => m !== undefined);
  }
  

  getOrCreateWorkerStats(wallet, workerName) {
    const workerKey = this.state.getWorkerKey(wallet, workerName);
    
    if (!this.workerStats.has(workerKey)) {
      this.workerStats.set(workerKey, {
        wallet: wallet || 'unknown',
        workerName: workerName || 'default',
        shares: 0,
        shareHistory: [],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        activeConnections: new Set(),
        rigId: workerName || 'default'
      });
    }
    
    return this.workerStats.get(workerKey);
  }
  

  getWorkerStats(workerKey) {
    return this.workerStats.get(workerKey);
  }
  

  getAllWorkerStats() {
    return this.workerStats;
  }
  

  updateAllLastActivity() {
    const now = Date.now();
    this.miners.forEach((minerInfo, minerId) => {
      if (minerInfo.connected && minerInfo.socket && minerInfo.socket.writable) {
        minerInfo.lastActivity = now;
        this.updateMiner(minerId, minerInfo);
      }
    });
  }
  

  cleanupStale() {
    const now = Date.now();
    const staleThreshold = CONFIG.staleConnectionThreshold;
    let removedCount = 0;
    

    const toRemove = [];
    
    this.miners.forEach((minerInfo, minerId) => {

      if (!minerInfo.connected && (now - minerInfo.lastActivity) > staleThreshold) {
        toRemove.push(minerId);
      }
    });
    

    for (const minerId of toRemove) {
      this.removeMiner(minerId);
      removedCount++;
    }
    
    if (removedCount > 0) {
      logger('info', `Cleaned up ${removedCount} stale miner connections, current total: ${this.miners.size}`);
    }
    
    return removedCount;
  }
  

  getRigIdCount() {
    return this.rigIdIndex.size;
  }
  

  getRigIdStats() {
    return Array.from(this.rigIdIndex || []).map(([rigId, minerIds]) => {
      return {
        rigId,
        minerCount: minerIds.size,
        activeMinerCount: Array.from(minerIds).filter(id => {
          const minerInfo = this.miners.get(id);
          return minerInfo && minerInfo.connected;
        }).length
      };
    });
  }
}

module.exports = MinerManager;
