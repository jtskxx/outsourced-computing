# 🛠️ XMR Stratum Pool for Qubic Network

A powerful **Node.js-based** Stratum bridge connecting **XMR miners** to the **Qubic Network**.  
Handles mining jobs, dynamic nonce distribution, solution submissions, persistent stats, and live admin control.

---

## ✨ Features

- Receives mining tasks from a **Qubic dispatcher**
- **Web Dashboard** for real-time stats, configuration, and **multi-computor** management
- **Dynamic Nonce Range** allocation per miner (optimized for AMD 7950X CPU AMD)
- **Multi-computor Support**:
  - Weighted random computor index assignment
- **Persistent stats** with automatic recovery after restarts
- **Weekly automatic share reset** (aligned with Qubic epochs)
- **No external database** needed; lightweight `.json` files used
- **Fully configurable** through simple constants inside the source code

---

## ⚙️ Configuration

Edit the `CONFIG` object directly in `server.js`:

| Key | Purpose |
|:----|:--------|
| `taskSourceHost` | IP/hostname of your listener |
| `taskSourcePort` | Listener port |
| `minerPort` | Port miners connect to |
| `shareDistributionPort` | Port for internal share forwarding |
| `statsPort` | Port for the Web Dashboard (default: 8088) |
| `adminPassword` | Password for admin access |
| `defaultComputorIndex` | Default computor index if no distribution is set |
| `nonceRangeSize` | Nonce range size per miner (default optimized for AMD 7950X) |
| `xmrShareDifficulty` | Miner share difficulty |
| `resetDay`, `resetHour`, `resetMinute` | Automatic weekly share reset schedule |

---

## 🖥️ Web Dashboard

- URL: `http://your-server-ip:8088/admin/computors`
- **Features**:
  - Real-time hashrate, shares, worker status
  - Add/remove computors dynamically
  - Adjust computor weights (live)
  - Batch add computors via identity
  - Fetch computor list from Qubic RPC
  - See active miners and their performance
- **Password protected** (set in `CONFIG.adminPassword`)

---

## 📊 Stats API

- `/stats` → Returns mining stats as JSON
- `/computor-list` → Returns full computor identity list

---

## 📦 Requirements

- **Node.js 18+**
- **Custom XMRig-Qubic Miner** ([Download Here](https://github.com/qubic/xmrig))

---

## 📚 Useful Commands

```bash
# Start the pool server
node server.js

# Access Web UI
http://your-server-ip:8088
```

---

## ⚡ Quick Tips

- **Adjust Nonce Range** (`nonceRangeSize`) for your hardware.  
  (Default optimized for AMD 7950X CPU.)
- **Update computor list** weekly to stay aligned with new Qubic epochs.
- **Monitor health** from logs to ensure stable connections.
- **Secure admin password** before opening dashboard to the internet.

---

## 🌟 Credits

Developed for the **Qubic Network** mining community.

Maintained by **Jetski**🥥
🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊

---

![image](https://github.com/user-attachments/assets/3a8b9596-ecc5-4938-9d71-58d02cf6b296)



