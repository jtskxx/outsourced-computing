# 🚀 Sender (XMR-Stratum ➡️ Qubic Network)

**Sender** is a custom-built bridge (based on **Qiner**) that connects an **XMR-Stratum server** directly to the **Qubic Network**.  
It **receives mining solutions (shares)** via TCP and **relays** them securely into the Qubic system — **signing** each with a valid Computor identity. 🛰️

---

## ✨ Features

- 📡 **TCP Listener for XMR-Stratum**: Accepts Monero mining solutions over TCP.
- 🔒 **Seed Signing & Validation**: Verifies and signs solutions before submitting to Qubic.

---

## 🛠️ How It Works

1. ✅ Solutions are sent from an **XMR-Stratum** server over **TCP**.
2. ✅ **Sender** processes each solution.
3. ✅ The signed solution is then properly formatted and broadcast into the **Qubic Network**.

---

## 📦 Dependencies

- [`keyUtils.h`](keyUtils.h)
- [`K12AndKeyUtil.h`](K12AndKeyUtil.h)
- Standard C++ libraries (`<cstdint>`, `<vector>`, etc.)

---

## 📚 Notes

- Sender must have **access to the Computor seed** to properly authenticate solutions.
- Lightweight and optimized for **low-latency mining relay**.


![image](https://github.com/user-attachments/assets/5ad65a09-8559-4e16-bc98-103c75ce8bc6)
