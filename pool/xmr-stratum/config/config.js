// Stratum proxy config
module.exports = {

  taskSourceHost: 'localhost',
  taskSourcePort: 8765,
  minerPort: 3333,
  shareDistributionPort: 8766,
  statsPort: 8088,
  

  adminPassword: 'Password',
  
  // Stats
  statsPath: './stats.json',
  statsInterval: 30000,
  persistentStatsPath: './persistent_stats.json',
  persistentStatsInterval: 150000, // 2.5 mins
  
  // Miners
  verbose: false,
  keepaliveTimeout: 600000, // 10 mins
  keepaliveInterval: 30000,
  hashrateWindow: 600000, // 10 mins
  xmrShareDifficulty: 10011000,
  jobRefreshInterval: 10, // secs to refresh stale jobs
  
  // Weekly reset (Wed 12PM UTC)
  resetDay: 3,
  resetHour: 12,
  resetMinute: 0,
  
  computorSettingsPath: './computor_settings.json',
  computorIndexesPath: './computor_indexes.json',
  computorAssignmentsPath: './computor_assignments.json',
  enabledComputorsPath: './enabled_computors.json',
  
  defaultEpoch: 162,
  rpcEndpoint: 'rpc.qubic.org',
  

  maxConnectionsPerIP: 10000, // adjust as needed
  connectionRateLimit: 10000, // adjust as needed
  connectionRateWindow: 60000, // 1 min window
  loginTimeout: 60000, // 60s
  bufferLimit: 1024 * 1024 * 50, // 50MB adjust as needed
  
  // Logging
  logStatInterval: 600000, // 10 min logs
  logHealthInterval: 600000,
  logKeepalive: false,
  logDetailedMinerEvents: false,
  

  logLevels: {
    error: true,
    warn: true,
    info: true,
    debug: false,
    share: false,
    job: true,
  },
  

  shareLogThreshold: 100,     // log every 100 shares
  logMinersThreshold: 5,      // top 5 miners
  
  // Circuit breaker
  circuitBreakerThreshold: 10,
  circuitBreakerResetTimeout: 30000, // 30s
  

  maxRecentJobs: 5, 
  maxJobCacheSize: 200, 
  jobRetentionTime: 3600000, // 1hr
  pruneShareHistoryInterval: 30000,
  

  duplicateShareWindow: 5000, // 5s
  

  rebalanceInterval: 1800000, // 30 mins
  
  // Memory mgmt
  staleConnectionThreshold: 86400000, // 24h
  cleanupInterval: 3600000, // 1hr cleanup
  
  // Parallel jobs
  maxActiveJobs: 10,
  maxJobAge: 600000,              // 10 min max age
  jobCleanupInterval: 60000,      // 1 min
  

  jobPriorityEnabled: false,
  priorityComputorRanges: [],
  
  // PostgreSQL
  postgresql: {
    enabled: false,
    dbConfig: {
      database: '',
      user: '',
      password: '',
      host: '',
      port: 0,
      ssl: {
        rejectUnauthorized: false
      }
    },
    exportInterval: 300000, // 5 mins
  }
};

// Nonce calc constants
module.exports.DOMAIN_SIZE = 25414007;
module.exports.MINER_NONCE_RANGE_SIZE = 250000; // 250k  
module.exports.MAX_MINERS_PER_COMPUTOR = 101; // Not enforced yet ! 
