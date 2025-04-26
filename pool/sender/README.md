# Sender (XMR-Stratum -> Qubic Network)

**Sender** is a custom-built solution based on **Qiner** that connects the XMR-Stratum  to the **Qubic Network**.  
Its primary role is to receive mining solutions (shares) via TCP and relay them correctly within the Qubic environment by signing them with a valid Computor identity.

---

## Features

-  **TCP Listener for XMR-Stratum**: Accepts Monero mining solutions via TCP connections.
-  **Seed Signing & Validation**: Ensures that only authorized Computors relay solutions into the network.
-  **Key Management**: Lightweight cryptographic functions for handling seeds, subseeds, public/private key generation, and identity verification.

---

## How It Works

- Solutions are sent from an XMR-Stratum server via TCP.
- The Sender authenticates these solutions by:
  - Generating a **subseed** from the given Computor seed.
  - Deriving a **private key** and **public key** from the subseed.
  - Creating a **Computor Identity** from the public key.

---

## Dependencies

- `keyUtils.h`
- `K12AndKeyUtil.h`
- Standard C++ libraries (`<cstdint>`, `<vector>`, etc.).


