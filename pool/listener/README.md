# 📡 Listener (Custom `oc_verifier`)

This is a **custom version** of `oc_verifier` that **only listens** to mining tasks from Qubic nodes and **relays** them via **TCP**.  
Perfect for connecting your miners using a **custom XMR Stratum Pool**!

> 🔔 **Note:**  
> `RandomX` **must be added** before building `listener`.
https://github.com/tevador/RandomX/tree/cb29ec5690c90a1358ec4ef67a969083bdf18864
---

## ⚙️ Build Instructions

```bash
mkdir build
cd build
cmake ..
make
```

✅ Cross-platform: Works on **Linux** and **Windows**!

---

## 🚀 Usage

```bash
./listener [node_ip0] [node_ip1] ... [node_ipN]
```

Connects to multiple Qubic nodes and listens for tasks.

---

## 📡 How It Works

- Receives **mining tasks** from connected nodes
- **Broadcasts** them over **TCP** on port `8765`
- Designed to feed tasks directly into a **custom Stratum server**

---


![image](https://github.com/user-attachments/assets/12a8a640-64e9-412a-bf75-293338df01ef)
