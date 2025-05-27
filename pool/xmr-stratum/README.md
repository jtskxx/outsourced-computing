# 🛠️ XMR Stratum Pool for Qubic Network
A powerful **Node.js-based** Stratum bridge connecting **XMR miners** to the **Qubic Network**.  
Handles mining jobs, dynamic nonce distribution, solution submissions, persistent stats, and live admin control.
---
## ✨ Features
- Receives mining tasks from a **Qubic dispatcher** with **parallel job processing**
- **Web Dashboard** for real-time stats, configuration, and **multi-computor** management
- **Dynamic Nonce Range** allocation per miner with **rig-id support**
- **PostgreSQL Integration** for scalable data export and analytics
- **Multi-computor Support**:
  - Random computor selection for true load distribution
  - Enable/disable specific computors
  - Automatic rebalancing every 30 minutes
- **Advanced Share Distribution**:
  - ALL shares forwarded (including duplicates)
  - Comprehensive share tracking and metrics
  - 5-second duplicate detection window
- **Job Management**:
  - Parallel processing of up to 10 concurrent jobs
  - Automatic job refresh for idle miners (10s default)
  - Job caching for late share submissions
- **Persistent stats** with automatic recovery after restarts
- **Weekly automatic share reset** (aligned with Qubic epochs)
- **Circuit breaker** pattern for fault tolerance
- **Rate limiting** and connection management
- **Modular architecture** with dedicated managers for state, miners, jobs, shares, and metrics
---
## ⚙️ Configuration
Edit the `config/config.js` file:
| Key | Purpose |
|:----|:--------|
| `taskSourceHost` | IP/hostname of your listener |
| `taskSourcePort` | Listener port |
| `minerPort` | Port miners connect to |
| `shareDistributionPort` | Port for internal share forwarding |
| `statsPort` | Port for the Web Dashboard (default: 8088) |
| `adminPassword` | Password for admin access |
| `jobRefreshInterval` | Seconds before refreshing stale jobs (default: 10) |
| `maxActiveJobs` | Maximum parallel jobs (default: 10) |
| `duplicateShareWindow` | Duplicate detection window in ms (default: 5000) |
| `rebalanceInterval` | Load rebalancing interval in ms (default: 1800000) |
| `postgresql.enabled` | Enable PostgreSQL export |
| `postgresql.dbConfig` | PostgreSQL connection settings |
| `resetDay`, `resetHour`, `resetMinute` | Automatic weekly share reset schedule |
---
## 🖥️ Web Dashboard
- URL: `http://your-server-ip:8088/admin/computors`
- **Features**:
  - Real-time hashrate, shares, worker status
  - Add/remove computors dynamically
  - Enable/disable specific computors
  - Batch add computors via identity
  - Fetch computor list from Qubic RPC
  - See active miners with rig-id tracking
  - Monitor parallel job processing
  - View share distribution metrics
  - Trigger manual load rebalancing
- **Password protected** (set in `CONFIG.adminPassword`)
---
## 📊 API Endpoints
- `/stats` → Complete mining statistics as JSON
- `/performance` → Detailed performance metrics
- `/health` → System health check
---
## 📦 Requirements
- **Node.js 14+**
- **PostgreSQL** (optional, for data export)
- **Custom XMRig-Qubic Miner** ([Download Here](https://github.com/qubic/xmrig))
---
## 🚀 Installation & Usage
```bash
# Install dependencies
npm install

# Start the pool
npm start

# Access Web UI
http://your-server-ip:8088
```
---
![image](https://github.com/user-attachments/assets/428b0109-92da-4603-b65c-c1fc60006021)

---
![image](https://github.com/user-attachments/assets/606ca5e5-734d-47c5-8c3d-272333db7f0e)


