# listener (Custom oc_verifier)

This version of oc_verifier only displays tasks sent by nodes. This custom version opens a TCP connection to relay tasks to the custom XMR stratum.

**Note:** RandomX needs to be added and compiled before building `listener`.

## Build

```bash
mkdir build
cd build
cmake ..
make
```

## Usage

```bash
./listener [node_ip0] [node_ip1] ... [node_ipN]
```

## Info
- Broadcasts mining tasks over TCP port `8765`.
- Cross-platform (Linux/Windows).
