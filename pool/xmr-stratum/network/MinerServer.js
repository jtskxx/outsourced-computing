const net = require('net');
const CONFIG = require('../config/config');
const NetworkHelper = require('../utils/NetworkHelper');
const { logger } = require('../utils/logger');

class MinerServer {
  constructor(state) {
    this.state = state;
    this.server = null;
    this.jobRefreshTimer = null;
    
    // Job broadcast listener
    this.state.on('broadcastJob', (job) => {
      this.broadcastJob(job);
    });
  }
  
  start() {
    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });
    
    this.server.on('error', (err) => {
      logger('error', `Miner server error: ${err.message}`);
    });
    
    this.server.on('close', () => {
      this.stopJobRefreshTimer();
    });
    
    this.server.listen(CONFIG.minerPort, '0.0.0.0', () => {
      logger('info', `Miner server listening on port ${CONFIG.minerPort}`);
      logger('info', `Share distribution fix V2 active - ALL shares will be distributed (including duplicates)`);
      logger('info', `Load balancing: Random selection among enabled computors`);
      logger('info', `Duplicate detection window: ${CONFIG.duplicateShareWindow / 1000} seconds`);
      logger('info', `Job refresh timer active - will refresh jobs after ${CONFIG.jobRefreshInterval || 10} seconds of inactivity`);
      
      // Log initial share counts
      const metrics = this.state.metrics.getMetrics();
      logger('info', `Initial share counts - Accepted: ${metrics.acceptedShares}, Duplicates: ${metrics.duplicates}, Total: ${metrics.totalSubmittedShares}`);
      if (this.state.shareTracking) {
        const tracking = this.state.shareTracking;
        logger('info', `Share tracking - Submitted: ${tracking.totalSubmitted}, Accepted: ${tracking.totalAccepted}, Distributed: ${tracking.totalDistributed}`);
      }
      
      // Start the job refresh timer
      this.startJobRefreshTimer();
    });
  }
  
  handleConnection(socket) {
    const ip = socket.remoteAddress;
    const port = socket.remotePort;
    const minerId = `${ip}:${port}`;
    
    // Rate limit check
    if (this.state.isRateLimited(ip)) {
      logger('warn', `Rate limit exceeded for ${ip}, connection refused`);
      socket.end('Rate limit exceeded');
      return;
    }
    
    // Log connections smartly to avoid spam
    if (this.state.miners.getTotalCount() < 10 || CONFIG.verbose) {
      logger('info', `Miner connected: ${minerId}`);
    } else if (this.state.miners.getTotalCount() % 10 === 0) {
      // Every 10th connection
      logger('info', `Miner milestone: ${this.state.miners.getTotalCount()} total connections`);
    }
    
    // Login timeout
    const loginTimeout = setTimeout(() => {
      if (socket.writable) {
        logger('warn', `Login timeout for ${minerId}, closing connection`);
        socket.end('Login timeout');
      }
    }, CONFIG.loginTimeout);
    

    this.state.miners.updateMiner(minerId, {
      socket: socket,
      wallet: null,
      workerName: null,
      workerKey: null,
      rigId: null,
      shares: 0,
      connected: true,
      lastActivity: Date.now(),
      lastJobSentTime: Date.now(),
      nonceRange: null
    });
    

    NetworkHelper.setupBufferedSocket(socket, (message) => {
      clearTimeout(loginTimeout);
      this.handleMinerMessage(minerId, message);
    });
    
    socket.on('end', () => {
      this.handleMinerDisconnect(minerId);
    });
    
    socket.on('error', (err) => {
      logger('error', `Miner socket error for ${minerId}: ${err.message}`);
    });
    
    socket.on('close', () => {
      this.handleMinerDisconnect(minerId);
    });
  }
  
  handleMinerDisconnect(minerId) {
    // Log important disconnections
    const minerInfo = this.state.miners.get(minerId);
    if (minerInfo && (CONFIG.verbose || minerInfo.shares > 0)) {
      logger('info', `Miner disconnected: ${minerId}, rig-id: ${minerInfo.rigId || 'unknown'}`);
    }
    
    if (minerInfo) {
      minerInfo.connected = false;
      minerInfo.socket = null; // prevent mem leaks
      

      this.state.miners.updateMiner(minerId, minerInfo);
      
      if (minerInfo.workerKey) {
        const workerStat = this.state.miners.getWorkerStats(minerInfo.workerKey);
        if (workerStat) {
          workerStat.activeConnections.delete(minerId);
          workerStat.lastSeen = new Date().toISOString();
        }
      }
    }
  }
  
  handleMinerMessage(minerId, message) {
    try {
      // Skip keepalive spam in logs
      if (CONFIG.verbose && message.method !== 'keepalive' && message.method !== 'keepalived') {
        logger('debug', `Received from ${minerId}: ${message.method}`);
      }
      
      const minerInfo = this.state.miners.get(minerId);
      if (!minerInfo) return;
      
      minerInfo.lastActivity = Date.now();
      this.state.miners.updateMiner(minerId, minerInfo);
      
      switch (message.method) {
        case 'login':
          this.handleLogin(minerId, message);
          break;
          
        case 'keepalived':
        case 'keepalive':
          this.handleKeepalive(minerId, message);
          break;
          
        case 'getjob':
          this.handleGetJob(minerId, message);
          break;
          
        case 'submit':
          this.handleSubmit(minerId, message);
          break;
          
        default:
          this.sendDefaultResponse(minerId, message);
      }
    } catch (error) {
      logger('error', `Error processing miner message from ${minerId}: ${error.message}`);
    }
  }
  
  handleLogin(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo) return;
    
    if (message.params && message.params.login) {
      const loginParts = message.params.login.split('.');
      minerInfo.wallet = loginParts[0];
      minerInfo.workerName = loginParts.length > 1 ? loginParts[1] : 'default';
      minerInfo.workerKey = this.state.getWorkerKey(minerInfo.wallet, minerInfo.workerName);
      minerInfo.lastSeen = new Date().toISOString();
      
      // Get rig-id
      if (message.params.rigid) {
        minerInfo.rigId = message.params.rigid;
      } else if (message.params.rig_id) {
        minerInfo.rigId = message.params.rig_id;
      } else {
        // fallback to worker name
        minerInfo.rigId = minerInfo.workerName;
      }
      
      this.state.miners.updateMiner(minerId, minerInfo);
      
      const workerStat = this.state.miners.getOrCreateWorkerStats(minerInfo.wallet, minerInfo.workerName);
      workerStat.rigId = minerInfo.rigId;
      workerStat.activeConnections.add(minerId);
      workerStat.lastSeen = new Date().toISOString();
      
      logger('info', `Miner ${minerId} logged in: ${minerInfo.wallet}, worker: ${minerInfo.workerName}, rig-id: ${minerInfo.rigId}`);
    }
    
    // Find job for this miner
    const activeJob = this.state.getActiveJobForMiner(minerInfo);
    
    if (activeJob) {

      const computorIndex = this.state.computors.getNextComputorIndex(
        activeJob.job.first_computor_index,
        activeJob.job.last_computor_index,
        minerInfo.workerKey
      );
      
      if (computorIndex !== null) {
        this.sendLoginWithJobResponse(minerId, message, computorIndex, activeJob);
      } else {
        this.sendBasicLoginResponse(minerId, message);
      }
    } else {
      // No job available
      logger('debug', `No active job with valid computors for login from ${minerId}`);
      this.sendBasicLoginResponse(minerId, message);
    }
  }
  
  sendBasicLoginResponse(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    const basicLoginResponse = {
      id: message.id,
      jsonrpc: "2.0",
      error: null,
      result: {
        id: minerId,
        status: "OK"
      }
    };
    
    minerInfo.socket.write(JSON.stringify(basicLoginResponse) + '\n');
  }
  
  sendLoginWithJobResponse(minerId, message, computorIndex, job) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable || !job) return;
    
  
    if (!minerInfo.rigId) {
      minerInfo.rigId = minerInfo.workerName || minerId;
      this.state.miners.updateMiner(minerId, minerInfo);
    }
    
    // Allocate nonce range
    const nonceRange = this.state.nonces.allocateNonceRange(
      job.job.job_id,
      computorIndex,
      job.job.first_computor_index,
      job.job.last_computor_index,
      minerInfo.rigId
    );
    
    minerInfo.nonceRange = nonceRange;
    minerInfo.lastJobSentTime = Date.now();
    this.state.miners.updateMiner(minerId, minerInfo);
    
    logger('debug', `Allocated nonce range: ${nonceRange.start_nonce} - ${nonceRange.end_nonce} for computor ${nonceRange.computorIndex}, rig-id: ${minerInfo.rigId}, job: ${job.job.job_id}`);
    
    const loginResponse = {
      id: message.id,
      jsonrpc: "2.0",
      error: null,
      result: {
        id: minerId,
        status: "OK",
        job: {
          blob: job.job.blob,
          job_id: job.job.job_id,
          target: job.job.target,
          id: minerId,
          seed_hash: job.job.seed_hash,
          height: job.job.height,
          algo: job.job.algo || "rx/0",
          computorIndex: nonceRange.computorIndex,
          start_nonce: nonceRange.start_nonce,
          end_nonce: nonceRange.end_nonce,
          first_computorIndex: job.job.first_computor_index,
          last_computorIndex: job.job.last_computor_index
        }
      }
    };
    
    minerInfo.socket.write(JSON.stringify(loginResponse) + '\n');
  }
  
  handleKeepalive(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    const pongResponse = {
      id: message.id || 0,
      jsonrpc: "2.0",
      error: null,
      result: {
        status: "OK"
      }
    };
    
    minerInfo.socket.write(JSON.stringify(pongResponse) + '\n');
    
    if (CONFIG.logKeepalive) {
      logger('debug', `Sent keepalive response to ${minerId}`);
    }
  }
  
  handleGetJob(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    // Find valid job
    const activeJob = this.state.getActiveJobForMiner(minerInfo);
    
    if (activeJob) {
      const computorIndex = this.state.computors.getNextComputorIndex(
        activeJob.job.first_computor_index,
        activeJob.job.last_computor_index,
        minerInfo.workerKey
      );
      
      if (computorIndex !== null) {

        if (!minerInfo.rigId) {
          minerInfo.rigId = minerInfo.workerName || minerId;
          this.state.miners.updateMiner(minerId, minerInfo);
        }
        

        const nonceRange = this.state.nonces.allocateNonceRange(
          activeJob.job.job_id,
          computorIndex,
          activeJob.job.first_computor_index,
          activeJob.job.last_computor_index,
          minerInfo.rigId
        );
        
        minerInfo.nonceRange = nonceRange;
        minerInfo.lastJobSentTime = Date.now();
        this.state.miners.updateMiner(minerId, minerInfo);
        
        const jobResponse = {
          id: message.id,
          jsonrpc: "2.0",
          error: null,
          result: {
            blob: activeJob.job.blob,
            job_id: activeJob.job.job_id,
            target: activeJob.job.target,
            id: minerId,
            seed_hash: activeJob.job.seed_hash,
            height: activeJob.job.height,
            algo: activeJob.job.algo || "rx/0",
            computorIndex: nonceRange.computorIndex,
            start_nonce: nonceRange.start_nonce,
            end_nonce: nonceRange.end_nonce,
            first_computorIndex: activeJob.job.first_computor_index,
            last_computorIndex: activeJob.job.last_computor_index
          }
        };
        
        minerInfo.socket.write(JSON.stringify(jobResponse) + '\n');
        
        if (CONFIG.logDetailedMinerEvents) {
          logger('debug', `Sent job ${activeJob.job.job_id} to ${minerId} with computor ${nonceRange.computorIndex}`);
        }
      } else {
        logger('debug', `No valid computor for getjob request from ${minerId}`);
        this.sendEmptyJobResponse(minerId, message);
      }
    } else {
      logger('debug', `No active job with valid computors for ${minerId}`);
      this.sendEmptyJobResponse(minerId, message);
    }
  }
  
  sendEmptyJobResponse(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    const emptyJobResponse = {
      id: message.id,
      jsonrpc: "2.0",
      error: null,
      result: { status: "NO_JOB" }
    };
    
    minerInfo.socket.write(JSON.stringify(emptyJobResponse) + '\n');
  }
  
  handleSubmit(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    

    if (!minerInfo) {
      logger('warn', `Share submission from unknown miner: ${minerId}`);
      return;
    }
    
    if (!minerInfo.workerKey) {
      logger('warn', `Share submission from miner without workerKey: ${minerId}`);
      return;
    }
    
    let shareProcessed = false;
    

    const submittedNonce = parseInt(message.params.nonce);
    let jobId = message.params.job_id || null;
    
    // Try to find job from nonce if needed
    if (!jobId || !this.state.jobs.hasJob(jobId)) {
      const jobInfo = this.state.nonces.findJobForNonce(submittedNonce);
      if (jobInfo) {
        jobId = jobInfo.jobId;
      }
    }
    

    if (this.state.shareTracking) {
      this.state.shareTracking.totalSubmitted++;
    }
    

    const isDuplicate = this.state.shares.recordShare(submittedNonce, jobId);
    

    

    if (this.state.shareTracking) {
      if (!isDuplicate) {
        this.state.shareTracking.totalAccepted++;
      }
    }
    
    if (isDuplicate) {
      logger('info', `Duplicate share detected from ${minerId} for job ${jobId}, nonce ${submittedNonce} - will distribute anyway`);
      

      const duplicateResponse = {
        id: message.id,
        jsonrpc: "2.0",
        error: {
          code: -1,
          message: "Duplicate share"
        }
      };
      
      if (minerInfo.socket && minerInfo.socket.writable) {
        minerInfo.socket.write(JSON.stringify(duplicateResponse) + '\n');
      }
      
      // Continue anyway - we distribute all shares
    }
    

    minerInfo.shares++;
    minerInfo.lastSeen = new Date().toISOString();
    this.state.miners.updateMiner(minerId, minerInfo);
    
    const workerStat = this.state.miners.getWorkerStats(minerInfo.workerKey);
    if (workerStat) {
      workerStat.shares++;
      workerStat.lastSeen = new Date().toISOString();
      

      workerStat.shareHistory.push(Date.now());
    }
    
    // Get job data
    let jobForShare = null;
    

    if (jobId && this.state.jobs.hasJob(jobId)) {
      jobForShare = this.state.jobs.getJob(jobId);
    }

    else if (jobId && this.state.hasActiveJob(jobId)) {
      jobForShare = this.state.getActiveJob(jobId);
    }

    else {
      jobForShare = this.state.currentJob;
    }
    
    // Last resort: reconstruct from nonce range
    if (!jobForShare && minerInfo.nonceRange && minerInfo.nonceRange.jobId) {
      const reconstructedJob = {
        job: {
          job_id: minerInfo.nonceRange.jobId,
          first_computor_index: minerInfo.nonceRange.firstComputorIndex || 0,
          last_computor_index: minerInfo.nonceRange.lastComputorIndex || 675,
          seed_hash: null,
        },
        id: null
      };
      logger('debug', `Reconstructing job info for share from miner ${minerId}, job ${minerInfo.nonceRange.jobId}`);
    }
    

    if (jobId && this.state.currentJob && jobId !== this.state.currentJob.job.job_id) {
      logger('share', `Share for previous job: ${jobId} (current: ${this.state.currentJob.job.job_id})`);
    }
    

    if (workerStat && workerStat.shares % CONFIG.shareLogThreshold === 0) {
      logger('share', `Miner ${minerId} (${minerInfo.wallet}, rig-id: ${minerInfo.rigId}) found a share! Total: ${workerStat.shares} (milestone)`);
    } else if (CONFIG.verbose) {
      logger('share', `Miner ${minerId} (${minerInfo.wallet}, rig-id: ${minerInfo.rigId}) found a share! Total: ${workerStat ? workerStat.shares : minerInfo.shares}`);
    }
    
    this.sendShareResponse(minerId, message);
    
    // Get computor index
    let computorIndex = null;
    if (minerInfo.nonceRange && minerInfo.nonceRange.computorIndex) {
      computorIndex = minerInfo.nonceRange.computorIndex;
    } else {

      const jobInfo = this.state.nonces.findJobForNonce(submittedNonce);
      if (jobInfo) {
        computorIndex = jobInfo.computorIndex;
      }
    }
    

    

    
    // Distribute share
    let shareMessage;
    
    if (jobForShare && jobForShare.job) {

      shareMessage = {
        params: {
          nonce: message.params.nonce,
          result: message.params.result
        },
        minerId: minerId,
        workerKey: minerInfo.workerKey,
        task_id: jobForShare.id || null,
        task_seed_hash: jobForShare.job.seed_hash || null,
        first_computor_index: jobForShare.job.first_computor_index || 0,
        last_computor_index: jobForShare.job.last_computor_index || 675,
        computorIndex: computorIndex,
        timestamp: Date.now()
      };
    } else {
      // Partial info - do our best
      shareMessage = {
        params: {
          nonce: message.params.nonce,
          result: message.params.result,
          job_id: jobId || (minerInfo.nonceRange && minerInfo.nonceRange.jobId) || message.params.job_id || 'unknown'
        },
        minerId: minerId,
        workerKey: minerInfo.workerKey,
        task_id: null,
        task_seed_hash: null,
        first_computor_index: (minerInfo.nonceRange && minerInfo.nonceRange.firstComputorIndex) || 0,
        last_computor_index: (minerInfo.nonceRange && minerInfo.nonceRange.lastComputorIndex) || 675,
        computorIndex: computorIndex || (minerInfo.nonceRange && minerInfo.nonceRange.computorIndex),
        timestamp: Date.now(),
        partial: true
      };
      

      if (this.state.shareTracking) {
        this.state.shareTracking.missingJobShares++;
      }
      logger('debug', `Distributing share with partial job info from ${minerId}, job: ${jobId || 'unknown'}`);
    }
    

    this.state.emit('share', shareMessage);
    shareProcessed = true;
    

    logger('info', `[ShareFlow] Share processed - Miner: ${minerId}, Duplicate: ${isDuplicate}, Computor: ${computorIndex}, Job: ${jobId || 'unknown'}`);
    

    if (isDuplicate) {
      logger('debug', `Duplicate share distributed successfully`);
    }
    
    // Periodic stats log
    if (this.state.shareTracking && this.state.shareTracking.totalSubmitted % 10 === 0) {
      const tracking = this.state.shareTracking;
      logger('info', `Share tracking - Submitted: ${tracking.totalSubmitted}, Accepted: ${tracking.totalAccepted}, Distributed: ${tracking.totalDistributed}, Missing Job: ${tracking.missingJobShares}`);
      

      const metrics = this.state.metrics.getMetrics();
      logger('info', `Metrics - Accepted: ${metrics.acceptedShares}, Duplicates: ${metrics.duplicates}, Total: ${metrics.totalSubmittedShares}`);
    }
  }
  
  sendShareResponse(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    const shareResponse = {
      id: message.id,
      jsonrpc: "2.0",
      error: null,
      result: {
        status: "OK"
      }
    };
    
    minerInfo.socket.write(JSON.stringify(shareResponse) + '\n');
  }
  
  sendDefaultResponse(minerId, message) {
    const minerInfo = this.state.miners.get(minerId);
    if (!minerInfo || !minerInfo.socket || !minerInfo.socket.writable) return;
    
    const defaultResponse = {
      id: message.id || 0,
      jsonrpc: "2.0",
      error: null,
      result: {
        status: "OK"
      }
    };
    
    minerInfo.socket.write(JSON.stringify(defaultResponse) + '\n');
    
    if (CONFIG.logDetailedMinerEvents) {
      logger('debug', `Default response for ${message.method} to ${minerId}`);
    }
  }
  
  broadcastJob(job) {
    let activeMiners = 0;
    let skippedMiners = 0;
    
    if (!job) {
      logger('job', `No job to broadcast`);
      return;
    }
    
    // Clean assignments for this job
    this.state.computors.cleanupInvalidAssignments(
      job.job.first_computor_index,
      job.job.last_computor_index
    );
    
    this.state.miners.forEach((minerInfo, minerId) => {
      if (minerInfo.connected && minerInfo.socket && minerInfo.socket.writable && minerInfo.workerKey) {

        const computorIndex = this.state.computors.getNextComputorIndex(
          job.job.first_computor_index,
          job.job.last_computor_index,
          minerInfo.workerKey
        );
        
        if (computorIndex === null) {
          // Skip - miner on different job
          skippedMiners++;
          return;
        }
        

        if (!minerInfo.rigId) {
          minerInfo.rigId = minerInfo.workerName || minerId;
          this.state.miners.updateMiner(minerId, minerInfo);
        }
        

        const nonceRange = this.state.nonces.allocateNonceRange(
          job.job.job_id,
          computorIndex,
          job.job.first_computor_index,
          job.job.last_computor_index,
          minerInfo.rigId
        );
        
        minerInfo.nonceRange = nonceRange;
        minerInfo.lastJobSentTime = Date.now();
        this.state.miners.updateMiner(minerId, minerInfo);
        
        const minerJob = {
          jsonrpc: "2.0",
          method: "job",
          params: {
            blob: job.job.blob,
            job_id: job.job.job_id,
            target: job.job.target,
            id: minerId,
            seed_hash: job.job.seed_hash,
            height: job.job.height,
            algo: job.job.algo || "rx/0",
            computorIndex: nonceRange.computorIndex,
            start_nonce: nonceRange.start_nonce,
            end_nonce: nonceRange.end_nonce,
            first_computorIndex: job.job.first_computor_index,
            last_computorIndex: job.job.last_computor_index
          }
        };
        
        try {
          minerInfo.socket.write(JSON.stringify(minerJob) + '\n');
          activeMiners++;
        } catch (error) {
          logger('error', `Error sending job ${job.job.job_id} to miner ${minerId}: ${error.message}`);
          minerInfo.connected = false;
          minerInfo.socket = null;
          this.state.miners.updateMiner(minerId, minerInfo);
        }
      }
    });
    
    logger('job', `Job ${job.job.job_id} broadcast to ${activeMiners} miners (${skippedMiners} skipped - may be on other jobs)`);
  }
  
  // Job refresh timer
  startJobRefreshTimer() {
    const interval = (CONFIG.jobRefreshInterval || 10) * 1000; // Default 10 seconds
    const checkInterval = 1000; // Check every second
    
    this.jobRefreshTimer = setInterval(() => {
      this.checkAndRefreshJobs();
    }, checkInterval);
    
    logger('info', `Job refresh timer started with ${interval/1000}s threshold, checking every ${checkInterval/1000}s`);
  }
  

  stopJobRefreshTimer() {
    if (this.jobRefreshTimer) {
      clearInterval(this.jobRefreshTimer);
      this.jobRefreshTimer = null;
      logger('info', 'Job refresh timer stopped');
    }
  }
  
  // Refresh stale jobs
  checkAndRefreshJobs() {
    const now = Date.now();
    const threshold = (CONFIG.jobRefreshInterval || 10) * 1000;
    let refreshedCount = 0;
    
    this.state.miners.forEach((minerInfo, minerId) => {

      if (minerInfo.connected && minerInfo.socket && minerInfo.socket.writable && minerInfo.workerKey) {
        const timeSinceLastJob = now - (minerInfo.lastJobSentTime || 0);
        
        if (timeSinceLastJob > threshold) {

          if (this.sendRandomJobToMiner(minerId, minerInfo)) {
            refreshedCount++;
          }
        }
      }
    });
    
    if (refreshedCount > 0) {
      logger('debug', `Refreshed jobs for ${refreshedCount} miners due to ${threshold/1000}s timeout`);
    }
  }
  
  // Pick random job for miner
  sendRandomJobToMiner(minerId, minerInfo) {

    const validJobs = [];
    
    for (const [jobId, job] of this.state.activeJobs) {
      const computorIndex = this.state.computors.getNextComputorIndex(
        job.job.first_computor_index,
        job.job.last_computor_index,
        minerInfo.workerKey
      );
      
      if (computorIndex !== null) {
        validJobs.push({ job, computorIndex });
      }
    }
    
    if (validJobs.length === 0) {
      logger('debug', `No valid jobs available for miner ${minerId} during refresh`);
      return false;
    }
    
    // Random selection
    const randomIndex = Math.floor(Math.random() * validJobs.length);
    const { job, computorIndex } = validJobs[randomIndex];
    

    if (!minerInfo.rigId) {
      minerInfo.rigId = minerInfo.workerName || minerId;
      this.state.miners.updateMiner(minerId, minerInfo);
    }
    

    const nonceRange = this.state.nonces.allocateNonceRange(
      job.job.job_id,
      computorIndex,
      job.job.first_computor_index,
      job.job.last_computor_index,
      minerInfo.rigId
    );
    
    minerInfo.nonceRange = nonceRange;
    minerInfo.lastJobSentTime = Date.now();
    this.state.miners.updateMiner(minerId, minerInfo);
    
    const minerJob = {
      jsonrpc: "2.0",
      method: "job",
      params: {
        blob: job.job.blob,
        job_id: job.job.job_id,
        target: job.job.target,
        id: minerId,
        seed_hash: job.job.seed_hash,
        height: job.job.height,
        algo: job.job.algo || "rx/0",
        computorIndex: nonceRange.computorIndex,
        start_nonce: nonceRange.start_nonce,
        end_nonce: nonceRange.end_nonce,
        first_computorIndex: job.job.first_computor_index,
        last_computorIndex: job.job.last_computor_index
      }
    };
    
    try {
      minerInfo.socket.write(JSON.stringify(minerJob) + '\n');
      logger('debug', `Sent refresh job ${job.job.job_id} to miner ${minerId} (timeout refresh)`);
      return true;
    } catch (error) {
      logger('error', `Error sending refresh job to miner ${minerId}: ${error.message}`);
      minerInfo.connected = false;
      minerInfo.socket = null;
      this.state.miners.updateMiner(minerId, minerInfo);
      return false;
    }
  }
}

module.exports = MinerServer;
