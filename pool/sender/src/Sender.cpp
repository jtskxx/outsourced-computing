#include <iostream>
#include <cstring>
#include <string>
#include <thread>
#include <vector>
#include <array>
#include <chrono>
#include <atomic>
#include <sstream>
#include <fstream>
#include <mutex>
#include <queue>
#include <condition_variable>
#include <algorithm>
#include <future>
#include <functional>

#include "K12AndKeyUtil.h"
#include "keyUtils.h"

// Platform specific includes
#ifdef _MSC_VER
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#endif

// Protocol constants
constexpr int MESSAGE_TYPE_SOLUTION = 2;  // Solution message type for gamming
constexpr int BROADCAST_MESSAGE = 1;      // Broadcast message type for header
constexpr int SIGNATURE_SIZE = 64;        // Qubic signature size in bytes

// Configuration
const char* HARDCODED_SEED = "seed";  // Default seed for key generation
constexpr int NODE_PORT = 21841;      // Default Qubic node port
constexpr int CONNECTION_TIMEOUT_MS = 2500; // 2.5s Connection timeout in milliseconds
constexpr int MAX_PARALLEL_SUBMISSIONS = 10; // Maximum number of parallel submissions

// Program state (0 = running, 1 = shutdown requested, exit on second signal)
static std::atomic<char> state(0);

// Node information structure
class NodeInfo {
public:
    std::string ip;
    int port;
    int successCount;
    int failureCount;
    bool active;
    
    NodeInfo(const std::string& ip, int port) 
        : ip(ip), port(port), successCount(0), failureCount(0), active(true) {}
    
    // Calculate success rate
    float getSuccessRate() const {
        int total = successCount + failureCount;
        if (total == 0) return 0.0f;
        return (float)successCount / total;
    }
};

// Vector of nodes to try - using an array for simplicity
std::array<NodeInfo, 13> nodes = {{
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT},
    {"xxx", NODE_PORT}
}};

// Mutex for logging and node statistics
std::mutex logMutex;
std::mutex nodesMutex;

// Thread-safe logging
template<typename... Args>
void log(Args&&... args) {
    std::lock_guard<std::mutex> lock(logMutex);
    (std::cout << ... << args) << std::endl;
}

// Platform-specific signal handling
#ifdef _MSC_VER
static BOOL WINAPI ctrlCHandlerRoutine(DWORD dwCtrlType) {
    if (!state) {
        state = 1;
        return TRUE;
    }
    std::exit(1);
    return TRUE;
}
#else
void ctrlCHandlerRoutine(int signum) {
    if (!state) {
        state = 1;
        return;
    }
    std::exit(1);
}
#endif

/**
 * Set up console control handler to gracefully shut down on Ctrl+C
 */
void setupSignalHandler() {
#ifdef _MSC_VER
    SetConsoleCtrlHandler(ctrlCHandlerRoutine, TRUE);
#else
    signal(SIGINT, ctrlCHandlerRoutine);
#endif
}

// Begin packed structures for network protocol

/**
 * Pack structures tightly for network transfer
 * This ensures no compiler-added padding between fields
 */
#ifdef _MSC_VER
#pragma pack(push, 1)
#else
#pragma pack(1)
#endif

 /**
  * Qubic protocol message header structure
  *
  * Format:
  * - 3 bytes: size (little endian)
  * - 1 byte: message type
  * - 4 bytes: dejavu (anti-replay)
  */
struct RequestResponseHeader {
private:
    unsigned char _size[3];    // Message size (3 bytes, little-endian)
    unsigned char _type;       // Message type (1 = broadcast, etc)
    unsigned int _dejavu;      // Anti-replay value

public:
    /**
     * Initialize header with default values
     */
    RequestResponseHeader() {
        memset(_size, 0, sizeof(_size));
        _type = 0;
        _dejavu = 0;
    }

    /**
     * Set message size (spread across 3 bytes in little-endian)
     */
    void setSize(unsigned int size) {
        _size[0] = size & 0xFF;
        _size[1] = (size >> 8) & 0xFF;
        _size[2] = (size >> 16) & 0xFF;
    }

    /**
     * Set message type
     */
    void setType(unsigned char type) {
        _type = type;
    }

    /**
     * Set dejavu value (anti-replay protection)
     */
    void setDejavu(unsigned int dejavu) {
        _dejavu = dejavu;
    }

    /**
     * Get size value (debug only)
     */
    unsigned int getSize() const {
        return _size[0] | (_size[1] << 8) | (_size[2] << 16);
    }

    /**
     * Get message type (debug only)
     */
    unsigned char getType() const {
        return _type;
    }

    /**
     * Get dejavu value (debug only)
     */
    unsigned int getDejavu() const {
        return _dejavu;
    }
};

/**
 * Solution structure for Qubic network
 */
struct Solution {
    unsigned char sourcePublicKey[32];  // Source public key (sender)
    unsigned char zero[32];             // Target public key or zeros for broadcast
    unsigned char gammingNonce[32];     // Nonce for gamming 
    unsigned long long taskIndex;       // Task index from mining task
    unsigned short firstComputorIndex;  // First computor index from task
    unsigned short lastComputorIndex;   // Last computor index from task
    unsigned int nonce;                 // Solution nonce value
    unsigned char result[32];           // Solution hash result 
    unsigned char signature[64];        // Ed25519 signature
};

#ifdef _MSC_VER
#pragma pack(pop)  // Restore default packing
#else
#pragma pack()     // Restore default packing
#endif

// End of packed structures

/**
 * Cross-platform socket client implementation
 * Handles differences between Windows and Unix socket APIs
 */
class SocketClient {
public:
    // Define platform-specific socket type
#ifdef _MSC_VER
    typedef SOCKET SocketType;
#else
    typedef int SocketType;
#endif

    SocketType sock;

    /**
     * Constructor - initialize socket subsystem
     */
#ifdef _MSC_VER
    SocketClient() {
        WSADATA wsaData;
        if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
            std::cerr << "Failed to initialize Winsock" << std::endl;
        }
    }

    /**
     * Destructor - clean up socket subsystem
     */
    ~SocketClient() {
        WSACleanup();
    }

    /**
     * Close an open socket
     */
    void closeSocket() {
        if (sock != INVALID_SOCKET) {
            closesocket(sock);
            sock = INVALID_SOCKET;
        }
    }

    /**
     * Connect to a remote host with timeout
     *
     * @param address IP address to connect to
     * @param port Port number to connect to
     * @param timeoutMs Timeout in milliseconds
     * @return true if connection successful, false otherwise
     */
    bool connect(const char* address, int port, int timeoutMs = CONNECTION_TIMEOUT_MS) {
        // Create socket
        sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (sock == INVALID_SOCKET) {
            return false;
        }

        // Set socket to non-blocking mode
        u_long mode = 1;
        if (ioctlsocket(sock, FIONBIO, &mode) != 0) {
            closeSocket();
            return false;
        }

        // Setup address structure
        sockaddr_in addr;
        ZeroMemory(&addr, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);

        // Convert IP address
        if (inet_pton(AF_INET, address, &addr.sin_addr) <= 0) {
            closeSocket();
            return false;
        }

        // Attempt to connect
        if (::connect(sock, (const sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR) {
            if (WSAGetLastError() != WSAEWOULDBLOCK) {
                closeSocket();
                return false;
            }
        }

        // Wait for connection or timeout
        fd_set write_set, except_set;
        FD_ZERO(&write_set);
        FD_ZERO(&except_set);
        FD_SET(sock, &write_set);
        FD_SET(sock, &except_set);

        // Set timeout
        timeval timeout;
        timeout.tv_sec = timeoutMs / 1000;
        timeout.tv_usec = (timeoutMs % 1000) * 1000;

        // Check if the socket is ready
        int selectResult = select(0, NULL, &write_set, &except_set, &timeout);

        // Set back to blocking mode
        mode = 0;
        ioctlsocket(sock, FIONBIO, &mode);

        if (selectResult <= 0 || !FD_ISSET(sock, &write_set) || FD_ISSET(sock, &except_set)) {
            closeSocket();
            return false;
        }

        return true;
    }
#else
     /**
      * Constructor - Unix version (no init. needed)
      */
    SocketClient() : sock(-1) {}

    /**
     * Close an open socket - Unix version
     */
    void closeSocket() {
        if (sock >= 0) {
            close(sock);
            sock = -1;
        }
    }

    /**
     * Connect to a remote host with timeout - Unix version
     * Simplified version that doesn't rely on fcntl
     *
     * @param address IP address to connect to
     * @param port Port number to connect to
     * @param timeoutMs Timeout in milliseconds
     * @return true if connection successful, false otherwise
     */
    bool connect(const char* address, int port, int timeoutMs = CONNECTION_TIMEOUT_MS) {
        // Create socket
        sock = socket(AF_INET, SOCK_STREAM, 0);
        if (sock < 0) {
            return false;
        }

        // Setup address structure
        sockaddr_in addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);

        // Convert IP address
        if (inet_pton(AF_INET, address, &addr.sin_addr) <= 0) {
            closeSocket();
            return false;
        }

        // Set socket timeout
        struct timeval tv;
        tv.tv_sec = timeoutMs / 1000;
        tv.tv_usec = (timeoutMs % 1000) * 1000;
        
        // Set receive timeout
        if (setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv)) < 0) {
            closeSocket();
            return false;
        }
        
        // Set send timeout
        if (setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tv, sizeof(tv)) < 0) {
            closeSocket();
            return false;
        }
        
        // Connect to server (blocking with timeout)
        if (::connect(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
            closeSocket();
            return false;
        }

        return true;
    }
#endif

    /**
     * Send all data in buffer (handles partial sends)
     *
     * @param socket Socket to send on
     * @param buffer Data to send
     * @param size Number of bytes to send
     * @return true if all data sent successfully, false on error
     */
    bool send(SocketType socket, char* buffer, unsigned int size) {
        unsigned int remaining = size;

        while (remaining > 0) {
            int sent = ::send(socket, buffer, remaining, 0);

            if (sent <= 0) {
                return false;
            }

            buffer += sent;
            remaining -= sent;
        }

        return true;
    }

    /**
     * Receive exact amount of data (or until timeout)
     *
     * @param socket Socket to receive from
     * @param buffer Buffer to store received data
     * @param size Number of bytes to receive
     * @return true if all requested bytes received, false otherwise
     */
    bool receive(SocketType socket, char* buffer, unsigned int size) {
        const auto startTime = std::chrono::steady_clock::now();
        constexpr unsigned int TIMEOUT_MS = 5000;  // 5s timeout
        unsigned int remaining = size;

        while (remaining > 0) {
            // Check timeout
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - startTime).count();

            if (elapsed > TIMEOUT_MS) {
                return false;
            }

            // Receive data
            int received = ::recv(socket, buffer, remaining, 0);

            if (received <= 0) {
                return false;
            }

            buffer += received;
            remaining -= received;
        }

        return true;
    }

    /**
     * Receive data until a newline character is found or timeout occurs
     * Used for reading line-based protocols like JSON
     *
     * @param socket Socket to receive from
     * @return String containing the received line (without the newline)
     */
    std::string receiveLine(SocketType socket) {
        std::string result;
        char buffer[4096];
        const auto startTime = std::chrono::steady_clock::now();
        constexpr unsigned int TIMEOUT_MS = 120000;  // 120 second (2 minute) timeout
        
        // Set socket to non-blocking mode to handle disconnects better
#ifdef _MSC_VER
        u_long mode = 1;
        ioctlsocket(socket, FIONBIO, &mode);
#else
        int flags_start = fcntl(socket, F_GETFL, 0);
        if (flags_start >= 0) {
            fcntl(socket, F_SETFL, flags_start | O_NONBLOCK);
        }
#endif

        while (true) {
            // Check timeout
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - startTime).count();

            if (elapsed > TIMEOUT_MS) {
                if (!result.empty()) {
                    break;  // Return what we've got so far
                }
                return "";  // Nothing received, report error
            }

            // Small sleep to reduce CPU usage during polling
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            
            // Receive chunk of data
            int received = ::recv(socket, buffer, sizeof(buffer) - 1, 0);
            
            if (received < 0) {
                // Check if it's just a would-block error (no data available)
#ifdef _MSC_VER
                if (WSAGetLastError() == WSAEWOULDBLOCK) {
                    continue;  // No data available yet, keep waiting
                }
#else
                if (errno == EAGAIN || errno == EWOULDBLOCK) {
                    continue;  // No data available yet, keep waiting
                }
#endif
                // Real error occurred
                break;
            } else if (received == 0) {
                // Connection closed by peer
                if (!result.empty()) {
                    break;  // Return what we've got so far
                }
                return "";  // Connection closed without data
            }

            // Null-terminate and append to result
            buffer[received] = '\0';
            result.append(buffer);

            // Check if we found a newline
            if (strchr(buffer, '\n') != nullptr) {
                break;
            }
        }

        // Set socket back to blocking mode
#ifdef _MSC_VER
        u_long mode = 0;
        ioctlsocket(socket, FIONBIO, &mode);
#else
        int flags_end = fcntl(socket, F_GETFL, 0);
        if (flags_end >= 0) {
            fcntl(socket, F_SETFL, flags_end & ~O_NONBLOCK);
        }
#endif

        return result;
    }
};

/**
 * JSON parsing utilities
 * Simple parsers for extracting values from JSON strings
 */

 /**
  * Extract a value (string or numeric) for a key from a JSON object
  *
  * @param json The JSON string to parse
  * @param key The key to look for (without quotes)
  * @return The value as string, or empty string if not found
  */
std::string getJsonValue(const std::string& json, const std::string& key) {
    // Format key with quotes for searching
    std::string quotedKey = "\"" + key + "\"";

    // Find the key
    size_t keyPos = json.find(quotedKey);
    if (keyPos == std::string::npos) {
        return "";
    }

    // Find the colon after the key
    size_t colonPos = json.find(":", keyPos);
    if (colonPos == std::string::npos) {
        return "";
    }

    // Skip whitespace after colon
    size_t valueStartPos = colonPos + 1;
    while (valueStartPos < json.length() && isspace(json[valueStartPos])) {
        valueStartPos++;
    }
    
    if (valueStartPos >= json.length()) {
        return "";
    }

    // Check if value is a string (starts with quote)
    if (json[valueStartPos] == '\"') {
        // Find the closing quote of the string value
        size_t valueEndPos = json.find("\"", valueStartPos + 1);
        if (valueEndPos == std::string::npos) {
            return "";
        }
        
        // Extract and return the string value
        return json.substr(valueStartPos + 1, valueEndPos - valueStartPos - 1);
    } 
    // Check if value is a number or other non-string value
    else {
        // Find the end of the value (comma, closing brace, bracket, or whitespace)
        size_t valueEndPos = valueStartPos;
        while (valueEndPos < json.length() && 
               json[valueEndPos] != ',' && 
               json[valueEndPos] != '}' && 
               json[valueEndPos] != ']' && 
               !isspace(json[valueEndPos])) {
            valueEndPos++;
        }
        
        // Extract and return the value
        return json.substr(valueStartPos, valueEndPos - valueStartPos);
    }
}

/**
 * Extract a value (string or numeric) from a nested JSON object
 *
 * @param json The JSON string to parse
 * @param parent The parent object key
 * @param key The key within the parent object
 * @return The value as string, or empty string if not found
 */
std::string getJsonValueNested(const std::string& json, const std::string& parent, const std::string& key) {
    // Format parent key with quotes for searching
    std::string quotedParent = "\"" + parent + "\"";

    // Find the parent key
    size_t parentPos = json.find(quotedParent);
    if (parentPos == std::string::npos) {
        return "";
    }

    // Find the colon after the parent key
    size_t colonPos = json.find(":", parentPos);
    if (colonPos == std::string::npos) {
        return "";
    }

    // Find the opening bracket of the parent object
    size_t bracketPos = json.find("{", colonPos);
    if (bracketPos == std::string::npos) {
        return "";
    }

    // Find the closing bracket of the parent object
    size_t bracketEndPos = json.find("}", bracketPos);
    if (bracketEndPos == std::string::npos) {
        return "";
    }

    // Extract the parent object as a substring
    std::string subJson = json.substr(bracketPos, bracketEndPos - bracketPos + 1);

    // Extract the value from the parent object
    return getJsonValue(subJson, key);
}

/**
 * Data conversion utilities
 */

 /**
  * Convert a hexadecimal string to binary data
  *
  * @param hex The hexadecimal string (2 characters per byte)
  * @param bin Output buffer for binary data
  * @param binSize Size of the output buffer
  */
void hexToBin(const std::string& hex, unsigned char* bin, size_t binSize) {
    // Process each byte (2 hex characters)
    for (size_t i = 0; i < binSize && i * 2 + 1 < hex.length(); i++) {
        unsigned int value = 0;
        std::string byteStr = hex.substr(i * 2, 2);
        sscanf(byteStr.c_str(), "%02x", &value);
        bin[i] = static_cast<unsigned char>(value);
    }
}

// Thread pool for parallel solution submission
class ThreadPool {
public:
    ThreadPool(size_t threads) : stop(false) {
        for (size_t i = 0; i < threads; ++i) {
            workers.emplace_back([this] {
                while (true) {
                    std::function<void()> task;
                    {
                        std::unique_lock<std::mutex> lock(this->queueMutex);
                        this->condition.wait(lock, [this] { 
                            return this->stop || !this->tasks.empty(); 
                        });
                        
                        if (this->stop && this->tasks.empty()) {
                            return;
                        }
                        
                        task = std::move(this->tasks.front());
                        this->tasks.pop();
                    }
                    
                    task();
                }
            });
        }
    }
    
    template<class F>
    void enqueue(F&& f) {
        {
            std::unique_lock<std::mutex> lock(queueMutex);
            if (stop) {
                throw std::runtime_error("enqueue on stopped ThreadPool");
            }
            tasks.emplace(std::forward<F>(f));
        }
        condition.notify_one();
    }
    
    ~ThreadPool() {
        {
            std::unique_lock<std::mutex> lock(queueMutex);
            stop = true;
        }
        condition.notify_all();
        for (std::thread &worker : workers) {
            worker.join();
        }
    }
    
private:
    std::vector<std::thread> workers;
    std::queue<std::function<void()>> tasks;
    std::mutex queueMutex;
    std::condition_variable condition;
    bool stop;
};

// Method to get best nodes by success rate
std::vector<size_t> getBestNodeIndices(size_t count) {
    std::lock_guard<std::mutex> lock(nodesMutex);
    
    // Create vector of indices
    std::vector<size_t> indices(nodes.size());
    for (size_t i = 0; i < nodes.size(); i++) {
        indices[i] = i;
    }
    
    // Sort indices by node success rate
    std::sort(indices.begin(), indices.end(), [](size_t a, size_t b) {
        return nodes[a].getSuccessRate() > nodes[b].getSuccessRate();
    });
    
    // Return top N indices
    if (count < indices.size()) {
        indices.resize(count);
    }
    
    return indices;
}

/**
 * Send a solution to a specific node
 *
 * @param nodeIndex Index of the node in the nodes array
 * @param message Pointer to the message to send
 * @param messageSize Size of the message in bytes
 * @param solutionTaskId Task ID of the solution (for logging)
 * @param solutionCount Sequential number of this solution (for logging)
 * @return true if submission was successful, false otherwise
 */
bool sendSolutionToNode(size_t nodeIndex, const char* message, size_t messageSize, 
                        unsigned long long solutionTaskId, int solutionCount) {
    // Lock for node access
    std::lock_guard<std::mutex> lock(nodesMutex);
    
    // Get node info
    NodeInfo& node = nodes[nodeIndex];
    
    // Skip inactive nodes
    if (!node.active) {
        return false;
    }
    
    // Try to connect to the node
    SocketClient nodeSocket;
    if (!nodeSocket.connect(node.ip.c_str(), node.port)) {
        // Connection failed
        log("Node ", node.ip, ":", node.port, " connection failed");
        return false;
    }
    
    // Need to copy the message since send() takes a non-const pointer
    char* messageCopy = new char[messageSize];
    memcpy(messageCopy, message, messageSize);
    
    // Send the solution
    bool success = nodeSocket.send(nodeSocket.sock, messageCopy, messageSize);
    
    // Free the message copy
    delete[] messageCopy;
    
    if (!success) {
        // Send failed
        log("Failed to send solution to node ", node.ip, ":", node.port);
        nodeSocket.closeSocket();
        return false;
    }
    
    // Solution sent successfully
    log("Solution #", solutionCount, " (Task ", solutionTaskId, 
        ") sent to ", node.ip, ":", node.port);
    
    nodeSocket.closeSocket();
    return true;
}

/**
 * Function for submitting a solution to nodes sequentially until one succeeds
 *
 * @param solution Pointer to the prepared solution message
 * @param messageSize Size of the message in bytes
 * @param solutionTaskId Task ID of the solution
 * @param solutionCount Sequential number of the solution
 */
void submitSolutionToNodes(const char* message, size_t messageSize, 
                          unsigned long long solutionTaskId, int solutionCount) {
    // Get the best nodes to try (based on success rate)
    std::vector<size_t> bestNodes = getBestNodeIndices(5);
    
    // Try nodes in order of success rate until one succeeds
    bool submissionSuccess = false;
    
    for (size_t i = 0; i < bestNodes.size() && !submissionSuccess; i++) {
        size_t nodeIndex = bestNodes[i];
        bool success = sendSolutionToNode(nodeIndex, message, messageSize, 
                                         solutionTaskId, solutionCount);
        
        if (success) {
            // Update node statistics (inside a lock)
            {
                std::lock_guard<std::mutex> lock(nodesMutex);
                nodes[nodeIndex].successCount++;
            }
            submissionSuccess = true;
        } else {
            // Update node statistics (inside a lock)
            {
                std::lock_guard<std::mutex> lock(nodesMutex);
                nodes[nodeIndex].failureCount++;
            }
        }
    }
    
    // Log overall status
    if (submissionSuccess) {
        log("Solution #", solutionCount, " (Task ", solutionTaskId, ") submitted successfully");
    } else {
        log("Solution #", solutionCount, " (Task ", solutionTaskId, ") submission FAILED to all tried nodes");
    }
}

/**
 * Process a solution received from the local provider and send it to multiple Qubic nodes
 *
 * @param jsonLine JSON string containing the solution data
 * @param signingSubseed Subseed for signing the solution
 * @param signingPublicKey Public key corresponding to the subseed
 * @param destinationPublicKey Target public key (for direct messages) or nullptr (for broadcast)
 * @param sendingDirectly Whether to send directly to a specific public key (true) or broadcast (false)
 * @param solutionCount Sequential number of this solution (for logging)
 * @param threadPool ThreadPool for parallel submissions
 * @return true if processing and sending succeeded, false otherwise
 */
bool processSolution(const std::string& jsonLine,
    unsigned char* signingSubseed,
    unsigned char* signingPublicKey,
    unsigned char* destinationPublicKey,
    bool sendingDirectly,
    int solutionCount,
    ThreadPool& threadPool) {
    try {
        // Extract required fields from JSON
        std::string task_id = getJsonValue(jsonLine, "task_id");
        std::string nonce = getJsonValueNested(jsonLine, "params", "nonce");
        std::string result = getJsonValueNested(jsonLine, "params", "result");
        
        // Extract the new fields
        std::string firstComputorIndex = getJsonValue(jsonLine, "first_computor_index");
        std::string lastComputorIndex = getJsonValue(jsonLine, "last_computor_index");

        // Validate required fields
        if (task_id.empty() || nonce.empty() || result.empty() || 
            firstComputorIndex.empty() || lastComputorIndex.empty()) {
            log("Error: Missing required fields in JSON data");
            log("Received JSON: ", jsonLine);
            return false;
        }

        // Create and initialize solution structure
        Solution solution;
        memset(&solution, 0, sizeof(Solution));

        // Set source public key (our identity)
        memcpy(solution.sourcePublicKey, signingPublicKey, 32);

        // Set destination key based on mode
        if (sendingDirectly) {
            memcpy(solution.zero, destinationPublicKey, 32);
        }
        else {
            memset(solution.zero, 0, 32);
        }

        // Set task index from task_id
        solution.taskIndex = std::stoull(task_id);
        
        // Set computor indices
        solution.firstComputorIndex = static_cast<unsigned short>(std::stoi(firstComputorIndex));
        solution.lastComputorIndex = static_cast<unsigned short>(std::stoi(lastComputorIndex));

        // FIX: Handle byte order for nonce conversion
        // First convert hex string to unsigned long
        unsigned long nonce_long = std::stoul(nonce, nullptr, 16);

        // Then cast to unsigned int (ensuring no data loss)
        unsigned int nonce_host = static_cast<unsigned int>(nonce_long);

        // Convert from host byte order to network byte order
        unsigned int nonce_network = htonl(nonce_host);

        // Assign network byte ordered value to solution structure
        solution.nonce = nonce_network;

        // Log simplified output
        log("Solution #", solutionCount, " - Task: ", solution.taskIndex,
            ", Nonce: 0x", std::hex, nonce_host, std::dec, 
            ", Computor range: ", solution.firstComputorIndex, 
            "-", solution.lastComputorIndex);

        // Set result hash from hex string
        hexToBin(result, solution.result, sizeof(solution.result));

        // Generate a valid gamming nonce
        unsigned char sharedKeyAndGammingNonce[64];
        memset(sharedKeyAndGammingNonce, 0, 32);

        unsigned char gammingKey[32];
        int attempts = 0;

        // Try random nonces until we find one that gives the right message type
        do {
            // Generate random gamming nonce using RDRAND instruction
            _rdrand64_step((unsigned long long*) & solution.gammingNonce[0]);
            _rdrand64_step((unsigned long long*) & solution.gammingNonce[8]);
            _rdrand64_step((unsigned long long*) & solution.gammingNonce[16]);
            _rdrand64_step((unsigned long long*) & solution.gammingNonce[24]);

            // Prepare input for KangarooTwelve
            memcpy(&sharedKeyAndGammingNonce[32], solution.gammingNonce, 32);

            // Hash to derive gamming key
            KangarooTwelve(sharedKeyAndGammingNonce, 64, gammingKey, 32);

            attempts++;
        } while (gammingKey[0] != MESSAGE_TYPE_SOLUTION);

        log("Found valid gamming nonce after ", attempts, " attempts");

        // Sign the solution
        uint8_t digest[32] = { 0 };
        size_t payloadSize = sizeof(Solution) - sizeof(solution.signature);

        KangarooTwelve(
            reinterpret_cast<unsigned char*>(&solution),
            payloadSize,
            digest,
            32
        );

        // Generate Ed25519 signature
        sign(signingSubseed, signingPublicKey, digest, solution.signature);

        // Create complete message with header
        struct CompleteMessage {
            RequestResponseHeader header;
            Solution payload;
        };
        
        // Allocate and initialize message structure in heap (will be freed by the thread)
        CompleteMessage* messagePtr = new CompleteMessage();
        memset(messagePtr, 0, sizeof(CompleteMessage));

        // Set header fields
        messagePtr->header.setType(BROADCAST_MESSAGE);
        messagePtr->header.setSize(sizeof(CompleteMessage));
        messagePtr->header.setDejavu(0);

        // Copy solution to payload
        messagePtr->payload = solution;

        // Store important values for the thread
        unsigned long long taskId = solution.taskIndex;
        
        // Submit the solution to nodes in a separate thread
        threadPool.enqueue([messagePtr, taskId, solutionCount]() {
            // Send the solution
            submitSolutionToNodes(
                reinterpret_cast<const char*>(messagePtr),
                sizeof(CompleteMessage),
                taskId,
                solutionCount
            );
            
            // Free the message memory
            delete messagePtr;
        });

        return true;
    }
    catch (const std::exception& e) {
        log("Error processing solution: ", e.what());
    }

    return false;
}

/**
 * Main entry point for the application
 */
int main(int argc, char* argv[]) {
    // Optional command-line arguments for additional nodes
    // (Note: This won't actually add nodes to our fixed-size array, but we'll keep the code for reference)
    if (argc > 1) {
        std::cout << "Additional node arguments will be ignored as predefined nodes are used." << std::endl;
    }

    // Configuration
    const char* solutionProviderIp = "127.0.0.1";  // Local solution provider
    int solutionProviderPort = 8766;               // Default port
    bool sendingDirectly = false;                  // Broadcasting by default
    unsigned char targetPublicKey[32] = { 0 };     // Empty target key

    // Set up signal handler for clean shutdown
    setupSignalHandler();

    // Initialize cryptographic keys from seed
    unsigned char signingSubseed[32];
    unsigned char signingPrivateKey[32];
    unsigned char signingPublicKey[32];

    // Key derivation chain
    getSubseedFromSeed(reinterpret_cast<unsigned char*>(const_cast<char*>(HARDCODED_SEED)), signingSubseed);
    getPrivateKeyFromSubSeed(signingSubseed, signingPrivateKey);
    getPublicKeyFromPrivateKey(signingPrivateKey, signingPublicKey);

    // Create thread pool for parallel submissions
    ThreadPool threadPool(MAX_PARALLEL_SUBMISSIONS);

    // Connect to local solution provider
    std::cout << "Starting parallelized solution sender..." << std::endl;
    std::cout << "Using " << nodes.size() << " nodes for submission" << std::endl;
    std::cout << "Connecting to solution provider at "
        << solutionProviderIp << ":" << solutionProviderPort << std::endl;

    SocketClient solutionClient;
    if (!solutionClient.connect(solutionProviderIp, solutionProviderPort)) {
        std::cerr << "Failed to connect to solution provider" << std::endl;
        return EXIT_FAILURE;
    }

    std::cout << "Connected to solution provider" << std::endl;

    // Main processing loop
    std::string buffer;          // Buffer for incoming data
    int solutionCount = 0;       // Counter for received solutions
    int reconnectDelaySeconds = 10; // Delay between reconnection attempts

    while (!state) {  // Run until signal handler sets state != 0
        // Receive data from solution provider
        std::string data = solutionClient.receiveLine(solutionClient.sock);

        // Handle connection loss
        if (data.empty()) {
            std::cout << "Connection lost. Reconnecting in " << reconnectDelaySeconds << " seconds..." << std::endl;
            solutionClient.closeSocket();

            // Wait before reconnecting
            std::this_thread::sleep_for(std::chrono::seconds(reconnectDelaySeconds));
            
            // Try to reconnect
            if (!solutionClient.connect(solutionProviderIp, solutionProviderPort)) {
                std::cout << "Reconnection failed. Trying again in " << reconnectDelaySeconds << " seconds..." << std::endl;
                continue;
            }
            std::cout << "Reconnected. Listening for solutions..." << std::endl;
            
            // Clear any partial data
            buffer.clear();
            continue;
        }

        // Append received data to buffer
        buffer += data;

        // Process complete JSON lines in the buffer
        size_t pos = 0;
        size_t newlinePos;

        while ((newlinePos = buffer.find('\n', pos)) != std::string::npos) {
            // Extract one line from buffer
            std::string jsonLine = buffer.substr(pos, newlinePos - pos);
            pos = newlinePos + 1;

            // Skip empty lines
            if (jsonLine.empty() || jsonLine == "\r") {
                continue;
            }

            // Process the solution
            solutionCount++;

            bool success = processSolution(
                jsonLine,
                signingSubseed,
                signingPublicKey,
                targetPublicKey,
                sendingDirectly,
                solutionCount,
                threadPool
            );

            if (!success) {
                std::cerr << "Solution #" << solutionCount << " processing failed" << std::endl;
            }
        }

        // Remove processed data from buffer
        if (pos > 0) {
            buffer.erase(0, pos);
        }

        // Small delay to prevent CPU spinning
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    // Clean shutdown
    solutionClient.closeSocket();
    std::cout << "Program terminated" << std::endl;

    return EXIT_SUCCESS;
}
