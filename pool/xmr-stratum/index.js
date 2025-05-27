const CONFIG = require('./config/config');
const { logger } = require('./utils/logger');

// Core state
const StateManager = require('./state/StateManager');

// Network stuff
const TaskSourceClient = require('./network/TaskSourceClient');
const MinerServer = require('./network/MinerServer');
const ShareDistributionServer = require('./network/ShareDistributionServer');

// Services
const StatisticsManager = require('./services/StatisticsManager');
const HttpServer = require('./services/HttpServer');
const PostgreSQLManager = require('./services/PostgreSQLManager');

// Main state
const state = new StateManager();

// Setup components
const taskSourceClient = new TaskSourceClient(state);
const minerServer = new MinerServer(state);
const shareDistributionServer = new ShareDistributionServer(state);
const statsManager = new StatisticsManager(state);
const httpServer = new HttpServer(state, statsManager);

// PostgreSQL setup if needed
let postgresqlManager = null;
if (CONFIG.postgresql && CONFIG.postgresql.enabled) {
  postgresqlManager = new PostgreSQLManager(state, CONFIG.postgresql.dbConfig);
  state.postgresql = postgresqlManager;
}

// Stats for postgres
state.statistics = statsManager;

// Let's get this party started
async function start() {
  logger('info', '=== Starting Stratum Proxy ===');
  logger('info', `Version: 3.0 (Refactored)`);
  logger('info', `Config: Task Source: ${CONFIG.taskSourceHost}:${CONFIG.taskSourcePort}`);
  logger('info', `Config: Miner Port: ${CONFIG.minerPort}`);
  logger('info', `Config: Share Distribution Port: ${CONFIG.shareDistributionPort}`);
  logger('info', `Config: Stats Port: ${CONFIG.statsPort}`);
  
  // Load saved data
  logger('info', 'Loading persisted data...');
  await statsManager.loadPersistentStats();
  await statsManager.loadComputorSettings();
  await statsManager.loadComputorAssignments();
  await statsManager.loadEnabledComputors();
  
  // Postgres init
  if (CONFIG.postgresql && CONFIG.postgresql.enabled) {
    logger('info', 'PostgreSQL is enabled in config');
    logger('info', `PostgreSQL config: host=${CONFIG.postgresql.dbConfig.host}, port=${CONFIG.postgresql.dbConfig.port}, db=${CONFIG.postgresql.dbConfig.database}`);
    
    if (postgresqlManager) {
      logger('info', 'Initializing PostgreSQL...');
      const pgInitialized = await postgresqlManager.initialize();
      if (!pgInitialized) {
        logger('warn', 'PostgreSQL initialization failed, continuing without database export');
      } else {
        logger('info', 'PostgreSQL initialized successfully');
      }
    } else {
      logger('error', 'PostgreSQL manager not created despite being enabled');
    }
  } else {
    logger('info', 'PostgreSQL is disabled in config');
  }
  
  // Fire up the network
  logger('info', 'Starting network components...');
  taskSourceClient.connect();
  minerServer.start();
  shareDistributionServer.start();
  httpServer.start();
  
  // Schedule recurring tasks
  setupPeriodicTasks();
  
  logger('info', '=== Stratum Proxy Started Successfully ===');
}

// Periodic task setup
function setupPeriodicTasks() {
  // Stats saver
  setInterval(async () => {
    try {
      await statsManager.saveStatsToFile();
      if (CONFIG.verbose) {
        logger('debug', 'Stats saved to file');
      }
    } catch (error) {
      logger('error', `Error saving stats: ${error.message}`);
    }
  }, CONFIG.statsInterval);
  
  // Long-term stats (less frequent)
  setInterval(async () => {
    try {
      await statsManager.savePersistentStats();
      logger('info', 'Persistent stats saved');
    } catch (error) {
      logger('error', `Error saving persistent stats: ${error.message}`);
    }
  }, CONFIG.persistentStatsInterval);
  
  // Weekly reset check
  setInterval(() => {
    state.checkAndResetShares();
  }, 60000); // every minute
  
  // Keep miners alive
  setInterval(() => {
    state.sendKeepaliveToMiners();
  }, CONFIG.keepaliveInterval);
  
  // Stats logging
  setInterval(() => {
    statsManager.logPeriodicStats();
  }, CONFIG.logStatInterval);
  
  // Clean old shares
  setInterval(() => {
    state.shares.pruneHistory();
  }, CONFIG.pruneShareHistoryInterval);
  
  // Remove dead connections
  setInterval(() => {
    state.cleanup();
  }, CONFIG.cleanupInterval);
  
  // Load balancing check
  setInterval(() => {
    state.computors.rebalanceLoadIfNeeded();
    state.computors.updateLoadMetrics();
  }, 60000);
  
  // Job cleanup
  setInterval(() => {
    state.cleanupActiveJobs();
  }, CONFIG.jobCleanupInterval || 60000); // default 1 min
}

// Clean shutdown
process.on('SIGINT', async () => {
  logger('info', 'Received SIGINT, shutting down gracefully...');
  
  try {
    // Save before exit
    await statsManager.savePersistentStats();
    logger('info', 'Final stats saved');
    
    // Close postgres
    if (postgresqlManager) {
      await postgresqlManager.shutdown();
    }
  } catch (error) {
    logger('error', `Error during shutdown: ${error.message}`);
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger('info', 'Received SIGTERM, shutting down gracefully...');
  
  try {
    // Save final stats
    await statsManager.savePersistentStats();
    logger('info', 'Final stats saved');
    
    // Shutdown PostgreSQL
    if (postgresqlManager) {
      await postgresqlManager.shutdown();
    }
  } catch (error) {
    logger('error', `Error during shutdown: ${error.message}`);
  }
  
  process.exit(0);
});

// Crash handler
process.on('uncaughtException', (error) => {
  logger('error', `Uncaught exception: ${error.message}`);
  logger('error', error.stack);
  process.exit(1);
});

// Promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger('error', `Unhandled rejection at: ${promise}, reason: ${reason}`);
  process.exit(1);
});

// Go!
start().catch((error) => {
  logger('error', `Failed to start: ${error.message}`);
  process.exit(1);
});
