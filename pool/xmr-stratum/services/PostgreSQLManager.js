const { Pool } = require('pg');
const { logger } = require('../utils/logger');

class PostgreSQLManager {
  constructor(state, config) {
    this.state = state;

    this.dbConfig = {
      ...config,
      ssl: config.ssl !== undefined ? config.ssl : {
        rejectUnauthorized: false
      }
    };
    this.pool = null;
    this.isConnected = false;
    this.exportInterval = null;
    this.lastExportTime = null;
  }

  async initialize() {
    try {
      logger('info', `Attempting PostgreSQL connection to ${this.dbConfig.host}:${this.dbConfig.port}`);
      logger('info', `Database: ${this.dbConfig.database || this.dbConfig.dbname}, User: ${this.dbConfig.user}`);
      
      // Connect
      this.pool = new Pool(this.dbConfig);
      

      const client = await this.pool.connect();
      const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
      client.release();
      
      logger('info', `PostgreSQL connected successfully!`);
      logger('info', `Server time: ${result.rows[0].current_time}`);
      logger('info', `PostgreSQL version: ${result.rows[0].pg_version}`);
      
      this.isConnected = true;
      

      await this.createTables();
      
      // 5-min export timer
      this.startExportInterval();
      
      return true;
    } catch (error) {
      logger('error', `PostgreSQL connection failed: ${error.message}`);
      logger('error', `Error stack: ${error.stack}`);
      this.isConnected = false;
      return false;
    }
  }

  async createTables() {
    try {
      const client = await this.pool.connect();
      
      try {
        logger('info', 'Creating PostgreSQL tables if they don\'t exist...');
        
        // Drop old tables for clean slate
        logger('info', 'Dropping old tables if they exist...');
        await client.query('DROP TABLE IF EXISTS mining_stats_current CASCADE');
        await client.query('DROP TABLE IF EXISTS mining_stats_archive CASCADE');
        await client.query('DROP TABLE IF EXISTS worker_stats CASCADE');
        
        // Current stats table
        await client.query(`
          CREATE TABLE IF NOT EXISTS worker_stats_current (
            worker_key VARCHAR(255) PRIMARY KEY,
            epoch INTEGER NOT NULL,
            wallet VARCHAR(255),
            worker_name VARCHAR(255),
            rig_id VARCHAR(255),
            shares BIGINT DEFAULT 0,
            active BOOLEAN DEFAULT false,
            last_seen TIMESTAMP WITH TIME ZONE,
            hashrate NUMERIC(20, 2) DEFAULT 0,
            last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          )
        `);
        
        // History for trends
        await client.query(`
          CREATE TABLE IF NOT EXISTS worker_stats_history (
            id SERIAL PRIMARY KEY,
            epoch INTEGER NOT NULL,
            worker_key VARCHAR(255) NOT NULL,
            wallet VARCHAR(255),
            worker_name VARCHAR(255),
            rig_id VARCHAR(255),
            shares BIGINT DEFAULT 0,
            active BOOLEAN DEFAULT false,
            last_seen TIMESTAMP WITH TIME ZONE,
            hashrate NUMERIC(20, 2) DEFAULT 0,
            timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          )
        `);
        
        // Indexes for speed
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_worker_stats_current_epoch ON worker_stats_current(epoch);
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_worker_stats_current_active ON worker_stats_current(active);
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_worker_stats_history_epoch ON worker_stats_history(epoch);
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_worker_stats_history_worker_key ON worker_stats_history(worker_key);
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_worker_stats_history_timestamp ON worker_stats_history(timestamp);
        `);
        
        logger('info', 'PostgreSQL tables created successfully');
        

        const checkResult = await client.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name IN ('worker_stats_current', 'worker_stats_history')
          ORDER BY table_name;
        `);
        
        logger('info', `Tables created: ${checkResult.rows.map(r => r.table_name).join(', ')}`);
        
      } finally {
        client.release();
      }
    } catch (error) {
      logger('error', `Error creating PostgreSQL tables: ${error.message}`);
      if (error.message.includes('permission denied')) {
        logger('error', 'User still lacks CREATE permissions. Please verify admin privileges were granted.');
      }
      throw error;
    }
  }

  startExportInterval() {
    // Export right away
    logger('info', 'Starting initial PostgreSQL export...');
    this.exportStats().catch(err => {
      logger('error', `Initial export failed: ${err.message}`);
    });
    
    // Then every 5 mins
    this.exportInterval = setInterval(() => {
      logger('debug', 'Running scheduled PostgreSQL export...');
      this.exportStats().catch(err => {
        logger('error', `Scheduled export failed: ${err.message}`);
      });
    }, 5 * 60 * 1000);
    
    logger('info', 'PostgreSQL export interval started (every 5 minutes)');
  }

  async exportStats() {
    if (!this.isConnected) {
      logger('warn', 'PostgreSQL not connected, skipping export');
      return;
    }

    try {

      if (!this.state.statistics) {
        logger('error', 'StatisticsManager not available in state');
        return;
      }
      
      logger('debug', 'Generating stats for PostgreSQL export...');
      const stats = this.state.statistics.generateStats();
      const currentEpoch = stats.currentEpoch || 0;
      
      logger('debug', `Exporting ${stats.workers.length} workers for epoch ${currentEpoch}`);
      
      const client = await this.pool.connect();
      const timestamp = new Date();
      
      try {
        await client.query('BEGIN');
        
        // Upsert worker stats
        for (const worker of stats.workers) {
          await client.query(`
            INSERT INTO worker_stats_current (
              worker_key, epoch, wallet, worker_name, rig_id,
              shares, active, last_seen, hashrate, last_updated
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
            )
            ON CONFLICT (worker_key) 
            DO UPDATE SET
              epoch = EXCLUDED.epoch,
              wallet = EXCLUDED.wallet,
              worker_name = EXCLUDED.worker_name,
              rig_id = EXCLUDED.rig_id,
              shares = EXCLUDED.shares,
              active = EXCLUDED.active,
              last_seen = EXCLUDED.last_seen,
              hashrate = EXCLUDED.hashrate,
              last_updated = EXCLUDED.last_updated
          `, [
            worker.workerKey, // worker_key
            currentEpoch, // epoch
            worker.wallet, // wallet
            worker.workerName, // worker_name
            worker.rigId, // rig_id
            worker.shares, // shares
            worker.active, // active
            worker.lastSeen ? new Date(worker.lastSeen) : null, // last_seen
            worker.hashrate, // hashrate
            timestamp // last_updated
          ]);
          
          // History entry
          await client.query(`
            INSERT INTO worker_stats_history (
              epoch, worker_key, wallet, worker_name, rig_id,
              shares, active, last_seen, hashrate, timestamp
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
            )
          `, [
            currentEpoch, // epoch
            worker.workerKey, // worker_key
            worker.wallet, // wallet
            worker.workerName, // worker_name
            worker.rigId, // rig_id
            worker.shares, // shares
            worker.active, // active
            worker.lastSeen ? new Date(worker.lastSeen) : null, // last_seen
            worker.hashrate, // hashrate
            timestamp // timestamp
          ]);
        }
        
        // Remove workers gone for 24+ hours
        await client.query(`
          DELETE FROM worker_stats_current 
          WHERE last_updated < $1
        `, [new Date(Date.now() - 24 * 60 * 60 * 1000)]);
        
        await client.query('COMMIT');
        
        this.lastExportTime = timestamp;
        logger('info', `PostgreSQL export successful: ${stats.workers.length} workers updated at ${this.lastExportTime.toISOString()}`);
        
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      
    } catch (error) {
      logger('error', `Error exporting stats to PostgreSQL: ${error.message}`);
      if (error.message.includes('does not exist')) {
        logger('error', 'Table not found. Attempting to recreate...');
        try {
          await this.createTables();
        } catch (createError) {
          logger('error', `Failed to recreate tables: ${createError.message}`);
        }
      }
    }
  }

  async shutdown() {
    if (this.exportInterval) {
      clearInterval(this.exportInterval);
      this.exportInterval = null;
    }

    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      logger('info', 'PostgreSQL connection closed');
    }
  }
}

module.exports = PostgreSQLManager;
