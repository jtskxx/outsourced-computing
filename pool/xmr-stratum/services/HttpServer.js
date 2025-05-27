const http = require('http');
const fsSync = require('fs');
const path = require('path');
const CONFIG = require('../config/config');
const { logger } = require('../utils/logger');

class HttpServer {
  constructor(state, statsManager) {
    this.state = state;
    this.statsManager = statsManager;
    this.server = null;
  }
  
  start() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    
    this.server.on('error', (err) => {
      logger('error', `HTTP server error: ${err.message}`);
    });
    
    this.server.listen(CONFIG.statsPort, '0.0.0.0', () => {
      logger('info', `HTTP server listening on port ${CONFIG.statsPort}`);
      logger('info', `Admin UI available at http://localhost:${CONFIG.statsPort}/admin/computors`);
    });
  }
  
  serveAdminHtml() {
    try {
      // Get admin.html from parent dir
      const adminPath = path.join(__dirname, '..', 'admin.html');
      let html = fsSync.readFileSync(adminPath, 'utf8');
      

      html = html.replace(/CURRENT_EPOCH/g, this.state.computors.currentEpoch);
      
      return html;
    } catch (error) {
      logger('error', `Error reading admin.html: ${error.message}`);
      return `
        <html>
          <body>
            <h1>Error</h1>
            <p>Could not load admin interface: ${error.message}</p>
            <p>Please make sure admin.html exists in the stratum-proxy directory.</p>
          </body>
        </html>
      `;
    }
  }
  
  async handleRequest(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    // Auth check for admin
    if (req.url.startsWith('/admin/')) {
      const authHeader = req.headers.authorization || '';
      
      if (!authHeader.startsWith('Basic ')) {
        res.writeHead(401, { 
          'Content-Type': 'text/plain',
          'WWW-Authenticate': 'Basic realm="Admin Access"'
        });
        res.end('Authentication required');
        return;
      }
      
      const base64Credentials = authHeader.split(' ')[1];
      const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
      const [username, password] = credentials.split(':');
      
      if (password !== CONFIG.adminPassword) {
        res.writeHead(401, { 
          'Content-Type': 'text/plain',
          'WWW-Authenticate': 'Basic realm="Admin Access"'
        });
        res.end('Invalid credentials');
        return;
      }
      
      // Strip /admin prefix
      req.url = req.url.replace('/admin', '');
    }
    
    // Root redirect
    if (req.url === '/') {
      res.writeHead(302, { 'Location': '/admin/computors' });
      res.end();
      return;
    }
    

    if (req.url === '/update-computor-weight' && req.method === 'POST') {
      this.handleUpdateComputorWeight(req, res);
    }
    else if (req.url === '/add-computor' && req.method === 'POST') {
      this.handleAddComputor(req, res);
    }
    else if (req.url === '/remove-computor' && req.method === 'POST') {
      this.handleRemoveComputor(req, res);
    }
    else if (req.url === '/add-identity-batch' && req.method === 'POST') {
      this.handleAddIdentityBatch(req, res);
    }
    else if (req.url === '/fetch-computor-list' && req.method === 'POST') {
      this.handleFetchComputorList(req, res);
    }
    else if (req.url === '/trigger-rebalance' && req.method === 'POST') {
      this.handleTriggerRebalance(req, res);
    }
    else if (req.url === '/enabled-computors' && req.method === 'GET') {
      this.handleGetEnabledComputors(req, res);
    }
    else if (req.url === '/set-enabled-computors' && req.method === 'POST') {
      this.handleSetEnabledComputors(req, res);
    }
    else if (req.url === '/computor-list' && req.method === 'GET') {
      this.handleGetComputorList(req, res);
    }
    else if (req.url === '/computors') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.serveAdminHtml());
    }
    else if (req.url === '/stats' || req.url === '/api/stats') {
      const stats = this.statsManager.generateStats();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats, null, 2));
      
      if (CONFIG.verbose) {
        logger('debug', `Stats served to ${req.socket.remoteAddress}`);
      }
    } 
    else if (req.url === '/performance' || req.url === '/api/performance') {
      // Performance metrics
      const perfStats = {
        computorLoad: this.state.computors.getLoadStats(),
        shareMetrics: {
          accepted: this.state.metrics.getMetrics().acceptedShares,
          duplicates: this.state.metrics.getMetrics().duplicateShares,
          totalSubmitted: this.state.metrics.getMetrics().totalSubmittedShares,
          acceptRate: this.state.metrics.getMetrics().acceptRate
        },
        taskMetrics: {
          processed: this.state.taskStats.processed,
          mined: this.state.taskStats.mined,
          skipped: this.state.taskStats.skipped,
          averageProcessingTime: this.state.taskStats.processingTimes.length > 0 
            ? this.state.taskStats.processingTimes.reduce((a, b) => a + b, 0) / this.state.taskStats.processingTimes.length 
            : 0,
          rebalanceInterval: CONFIG.rebalanceInterval,
          lastRebalanced: this.state.computors.lastRebalanceTime ? new Date(this.state.computors.lastRebalanceTime).toISOString() : null
        },
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime()
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(perfStats, null, 2));
    }
    else if (req.url === '/health') {
      // Health check
      const health = {
        status: 'OK',
        uptime: process.uptime(),
        connections: {
          taskSource: this.state.circuitBreakers.has('taskSource') 
            ? this.state.circuitBreakers.get('taskSource').state 
            : 'UNKNOWN',
          miners: this.state.miners.getActiveCount(),
          shareClients: 0 // Would need to expose from ShareDistributionServer
        }
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
    }
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }
  
  handleUpdateComputorWeight(req, res) {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        if (data.computorSettings && Array.isArray(data.computorSettings)) {

          this.state.computors.setDistribution(data.computorSettings);
          this.state.emit('computorDistributionChanged');
          await this.statsManager.saveComputorDistribution();
          

          if (data.epoch) {
            this.state.computors.currentEpoch = data.epoch;
            await this.statsManager.fetchComputorList(data.epoch);
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true, 
            message: 'Computor settings updated successfully',
            computorCount: data.computorSettings.length 
          }));
        } else if (typeof data.index === 'number') {
          // Single update (legacy)
          const distribution = this.state.computors.getDistribution();
          const computor = distribution[data.index];
          
          if (computor) {

            this.state.emit('computorDistributionChanged');
            await this.statsManager.saveComputorDistribution();
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: true, 
              message: `Updated computor ${computor.index}`
            }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: false,
              message: 'Computor not found' 
            }));
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request format' }));
        }
      } catch (error) {
        logger('error', `Error updating computor settings: ${error.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  }
  
  handleAddComputor(req, res) {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { index, weight, identity } = data;
        
        if (typeof index !== 'number' || index < 0 || index > 675) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false,
            message: 'Invalid computor index' 
          }));
          return;
        }
        
        // Weight ignored (legacy compat)
        const effectiveWeight = weight || 1;
        
        const distribution = this.state.computors.getDistribution();
        

        const existing = distribution.find(c => c.index === index);
        if (existing) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false,
            message: `Computor ${index} already exists` 
          }));
          return;
        }
        

        distribution.push({ index, identity: identity || null });
        

        distribution.sort((a, b) => a.index - b.index);
        
        this.state.emit('computorDistributionChanged');
        await this.statsManager.saveComputorDistribution();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: `Added computor ${index}`
        }));
        
        logger('info', `Added computor ${index}`);
      } catch (error) {
        logger('error', `Error adding computor: ${error.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  }
  
  handleRemoveComputor(req, res) {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { index } = data;
        
        const distribution = this.state.computors.getDistribution();
        const computorIndex = distribution.findIndex(c => c === distribution[index]);
        
        if (computorIndex === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false,
            message: 'Computor not found' 
          }));
          return;
        }
        

        distribution.splice(computorIndex, 1);
        
        this.state.emit('computorDistributionChanged');
        await this.statsManager.saveComputorDistribution();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: 'Computor removed successfully'
        }));
        
        logger('info', `Removed computor at index ${index}`);
      } catch (error) {
        logger('error', `Error removing computor: ${error.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  }
  
  handleAddIdentityBatch(req, res) {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { identities, weight } = data;
        
        if (!Array.isArray(identities) || identities.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false,
            message: 'No identities provided' 
          }));
          return;
        }
        
        // Weight ignored
        const effectiveWeight = weight || 1;
        
        // Need computor list for identity->index conversion
        const computorIdentities = this.state.computors.computorIdentities || [];
        
        if (computorIdentities.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false,
            message: 'No computor list loaded. Please fetch the computor list first.' 
          }));
          return;
        }
        
        const distribution = this.state.computors.getDistribution();
        let addedCount = 0;
        
        for (const identity of identities) {
          const index = computorIdentities.indexOf(identity);
          if (index !== -1) {

            if (!distribution.find(c => c.index === index)) {
              distribution.push({ index, identity });
              addedCount++;
            }
          }
        }
        
        if (addedCount > 0) {

          distribution.sort((a, b) => a.index - b.index);
          
          this.state.emit('computorDistributionChanged');
          await this.statsManager.saveComputorDistribution();
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: `Added ${addedCount} computors from ${identities.length} identities`
        }));
        
        logger('info', `Batch added ${addedCount} computors`);
      } catch (error) {
        logger('error', `Error batch adding computors: ${error.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  }
  
  handleFetchComputorList(req, res) {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { epoch } = data;
        
        if (typeof epoch !== 'number' || epoch < 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false,
            message: 'Invalid epoch number' 
          }));
          return;
        }
        
        const result = await this.statsManager.fetchComputorList(epoch);
        
        if (result) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true, 
            message: `Fetched computor list for epoch ${epoch} successfully`
          }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false,
            message: 'Failed to fetch computor list' 
          }));
        }
      } catch (error) {
        logger('error', `Error fetching computor list: ${error.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  }
  
  handleTriggerRebalance(req, res) {
    try {
      // Force rebalance
      this.state.computors.minerComputorAssignments.clear();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: 'Miner assignments cleared. New assignments will be random.'
      }));
      
      logger('info', 'Manual reassignment triggered via admin API - cleared all computor assignments');
    } catch (error) {
      logger('error', `Error triggering reassignment: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
  
  handleGetComputorList(req, res) {
    try {
      const identities = this.state.computors.computorIdentities || [];
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(identities));
    } catch (error) {
      logger('error', `Error getting computor list: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
    }
  }
  
  handleGetEnabledComputors(req, res) {
    try {
      const enabledComputors = Array.from(this.state.computors.enabledComputors);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabledComputors }));
    } catch (error) {
      logger('error', `Error getting enabled computors: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabledComputors: [] }));
    }
  }
  
  handleSetEnabledComputors(req, res) {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { enabledComputors } = data;
        
        if (!Array.isArray(enabledComputors)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false,
            message: 'Invalid request format' 
          }));
          return;
        }
        

        this.state.computors.setEnabledComputors(enabledComputors);
        

        await this.statsManager.saveEnabledComputors(enabledComputors);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: enabledComputors.length === 0 
            ? 'All computors enabled for mining' 
            : `Enabled ${enabledComputors.length} computors for mining`
        }));
        
        logger('info', `Updated enabled computors: ${enabledComputors.length === 0 ? 'All' : enabledComputors.join(', ')}`);
      } catch (error) {
        logger('error', `Error setting enabled computors: ${error.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  }
}

module.exports = HttpServer;
