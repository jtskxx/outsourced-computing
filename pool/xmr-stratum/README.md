# XMR Stratum Pool for Qubic Network

This is a Node.js-based XMR Stratum Pool that acts as a bridge between miners, a Qubic task dispatcher, and a solution sender.  
It manages mining jobs, nonce allocation, statistics tracking, and solution submissions to the Qubic network.

## Features

- Connects **XMR miners** via the **Stratum protocol**
- Receives tasks from a **dispatcher** and distributes jobs to miners
- Submits found solutions to the **Qubic network**
- Web dashboard for live stats and **computor index** configuration
- Supports **dynamic nonce range** allocation for each miner
- Automatic weekly share reset (aligned with Qubic Epochs)
- Persistent stats storage and recovery
- Tuned default nonce range (`155480000`) for **AMD 7950X CPUs**
- Fully configurable via `CONFIG` constants

## Configuration

You can edit configuration values directly inside the source code under the `CONFIG` object:
- **taskSourceHost**: IP or hostname of your task dispatcher
- **taskSourcePort**: Port of your task dispatcher
- **minerPort**: Port miners connect to
- **shareDistributionPort**: Port for internal share forwarding
- **statsPort**: Port for the HTTP stats UI
- **defaultComputorIndex**: Default computor index to mine for
- **nonceRangeSize**: Size of nonce range per miner (default tuned for AMD 7950X)
- **xmrShareDifficulty**: Difficulty of miner shares
- **resetDay, resetHour, resetMinute**: Automatic share reset schedule (default: Wednesday 12PM UTC)

## Web UI

- **Stats Dashboard & Computor Config**:  
  Visit `http://your-server-ip:8088/`
- Allows viewing **hashrate, active workers, shares, uptime**
  Visit `http://your-server-ip:8088/stats`
- Change **computor index** live without restarting the server

## Notes

- Each miner gets a **random, non-overlapping nonce range** per job.
- No external database needed; persistent stats are saved to local `.json` files.

## Requirements

- Node.js 18+
- Custom XMRig-Qubic
  Visit `https://github.com/qubic/xmrig`


  ![image](https://github.com/user-attachments/assets/f014e079-e05d-4b96-89bd-f094826ff8b6)
