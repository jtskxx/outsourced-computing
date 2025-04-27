#include <iostream>
#include <cstring>
#include <string>
#include <thread>
#include <vector>
#include <chrono>
#include <atomic>
#include <sstream>
#include <fstream>

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
#endif

// Protocol constants
constexpr int MESSAGE_TYPE_SOLUTION = 2;  // Solution message type for gamming
constexpr int BROADCAST_MESSAGE = 1;      // Broadcast message type for header
constexpr int SIGNATURE_SIZE = 64;        // Qubic signature size in bytes

// Configuration
const char* HARDCODED_SEED = "seed";  // Default seed for key generation

// Program state (0 = running, 1 = shutdown requested, exit on second signal)
static std::atomic<char> state(0);

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
    unsigned int nonce;                 // Solution nonce value
    unsigned int padding;               // Reserved
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
     * Connect to a remote host
     *
     * @param address IP address to connect to
     * @param port Port number to connect to
     * @return true if connection successful, false otherwise
     */
    bool connect(const char* address, int port) {
        // Create socket
        sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (sock == INVALID_SOCKET) {
            std::cerr << "Failed to create socket: " << WSAGetLastError() << std::endl;
            return false;
        }

        // Setup address structure
        sockaddr_in addr;
        ZeroMemory(&addr, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);

        // Convert IP address
        if (inet_pton(AF_INET, address, &addr.sin_addr) <= 0) {
            std::cerr << "Invalid IP address: " << address << std::endl;
            closeSocket();
            return false;
        }

        // Connect to server
        if (::connect(sock, (const sockaddr*)&addr, sizeof(addr)) != 0) {
            std::cerr << "Failed to connect to " << address << ":" << port
                << " (Error: " << WSAGetLastError() << ")" << std::endl;
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
     * Connect to a remote host - Unix version
     *
     * @param address IP address to connect to
     * @param port Port number to connect to
     * @return true if connection successful, false otherwise
     */
    bool connect(const char* address, int port) {
        // Create socket
        sock = socket(AF_INET, SOCK_STREAM, 0);
        if (sock < 0) {
            std::cerr << "Failed to create socket: " << errno << std::endl;
            return false;
        }

        // Setup address structure
        sockaddr_in addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);

        // Convert IP address
        if (inet_pton(AF_INET, address, &addr.sin_addr) <= 0) {
            std::cerr << "Invalid IP address: " << address << std::endl;
            closeSocket();
            return false;
        }

        // Connect to server
        if (::connect(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
            std::cerr << "Failed to connect to " << address << ":" << port
                << " (Error: " << errno << ")" << std::endl;
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
                std::cerr << "Send error: " <<
#ifdef _MSC_VER
                    WSAGetLastError()
#else
                    errno
#endif
                    << std::endl;
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
        constexpr unsigned int TIMEOUT_MS = 10000;  // 10 s timeout
        unsigned int remaining = size;

        while (remaining > 0) {
            // Check timeout
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - startTime).count();

            if (elapsed > TIMEOUT_MS) {
                std::cerr << "Receive timeout after " << elapsed << "ms" << std::endl;
                return false;
            }

            // Receive data
            int received = ::recv(socket, buffer, remaining, 0);

            if (received <= 0) {
                std::cerr << "Receive error: " <<
#ifdef _MSC_VER
                    WSAGetLastError()
#else
                    errno
#endif
                    << std::endl;
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
        constexpr unsigned int TIMEOUT_MS = 10000;  // 10 second timeout

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

            // Receive chunk of data
            int received = ::recv(socket, buffer, sizeof(buffer) - 1, 0);

            if (received <= 0) {
                break;
            }

            // Null-terminate and append to result
            buffer[received] = '\0';
            result.append(buffer);

            // Check if we found a newline
            if (strchr(buffer, '\n') != nullptr) {
                break;
            }
        }

        return result;
    }
};

/**
 * JSON parsing utilities
 * Simple parsers for extracting values from JSON strings
 */

 /**
  * Extract a string value for a key from a JSON object
  *
  * @param json The JSON string to parse
  * @param key The key to look for (without quotes)
  * @return The string value, or empty string if not found
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

    // Find the opening quote of the value
    size_t valueStartPos = json.find("\"", colonPos);
    if (valueStartPos == std::string::npos) {
        return "";
    }

    // Find the closing quote of the value
    size_t valueEndPos = json.find("\"", valueStartPos + 1);
    if (valueEndPos == std::string::npos) {
        return "";
    }

    // Extract and return the value
    return json.substr(valueStartPos + 1, valueEndPos - valueStartPos - 1);
}

/**
 * Extract a string value from a nested JSON object
 *
 * @param json The JSON string to parse
 * @param parent The parent object key
 * @param key The key within the parent object
 * @return The string value, or empty string if not found
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

/**
 * Print binary data as formatted hexadecimal - only when necessary
 *
 * @param label Label to print before the data
 * @param data Pointer to the binary data
 * @param size Size of the data in bytes
 */
void printHex(const char* label, const unsigned char* data, size_t size) {
    std::cout << label << ": ";

    for (size_t i = 0; i < size; i++) {
        printf("%02x", data[i]);
    }

    std::cout << std::endl;
}

/**
 * Process a solution received from the local provider and send it to the Qubic node
 *
 * @param jsonLine JSON string containing the solution data
 * @param signingSubseed Subseed for signing the solution
 * @param signingPublicKey Public key corresponding to the subseed
 * @param destinationPublicKey Target public key (for direct messages) or nullptr (for broadcast)
 * @param sendingDirectly Whether to send directly to a specific public key (true) or broadcast (false)
 * @param nodeIp IP address of the Qubic node
 * @param nodePort Port number of the Qubic node
 * @param solutionCount Sequential number of this solution (for logging)
 * @return true if processing and sending succeeded, false otherwise
 */
bool processSolution(const std::string& jsonLine,
    unsigned char* signingSubseed,
    unsigned char* signingPublicKey,
    unsigned char* destinationPublicKey,
    bool sendingDirectly,
    const char* nodeIp,
    int nodePort,
    int solutionCount) {
    try {
        // Extract required fields from JSON
        std::string task_id = getJsonValue(jsonLine, "task_id");
        std::string nonce = getJsonValueNested(jsonLine, "params", "nonce");
        std::string result = getJsonValueNested(jsonLine, "params", "result");

        // Validate required fields
        if (task_id.empty() || nonce.empty() || result.empty()) {
            std::cerr << "Error: Missing required fields in JSON data" << std::endl;
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
        std::cout << "Solution #" << solutionCount << " - Task: " << solution.taskIndex
            << ", Nonce: 0x" << std::hex << nonce_host << std::dec << std::endl;

        // Set padding field to zero (reserved for future use)
        solution.padding = 0;

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

        std::cout << "Found valid gamming nonce after " << attempts << " attempts" << std::endl;

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
        } message;

        // Initialize message structure
        memset(&message, 0, sizeof(CompleteMessage));

        // Set header fields
        message.header.setType(BROADCAST_MESSAGE);
        message.header.setSize(sizeof(CompleteMessage));
        message.header.setDejavu(0);

        // Copy solution to payload
        message.payload = solution;

        // Send message to node
        SocketClient nodeSocket;
        if (nodeSocket.connect(nodeIp, nodePort)) {
            if (nodeSocket.send(nodeSocket.sock, reinterpret_cast<char*>(&message), sizeof(CompleteMessage))) {
                std::cout << "Solution sent to " << nodeIp << ":" << nodePort << std::endl;
                nodeSocket.closeSocket();
                return true;
            }
            else {
                std::cerr << "Failed to send solution to node" << std::endl;
            }

            nodeSocket.closeSocket();
        }
        else {
            std::cerr << "Failed to connect to node at " << nodeIp << ":" << nodePort << std::endl;
        }
    }
    catch (const std::exception& e) {
        std::cerr << "Error processing solution: " << e.what() << std::endl;
    }

    return false;
}

/**
 * Main entry point for the application
 */
int main(int argc, char* argv[]) {
    // Validate command-line arguments
    if (argc < 3) {
        std::cerr << "Usage: Sender <Node IP> <Node Port>" << std::endl;
        return EXIT_FAILURE;
    }

    // Configuration
    const char* solutionProviderIp = "127.0.0.1";  // Local solution provider
    int solutionProviderPort = 8766;               // Default port
    const char* nodeIp = argv[1];                  // Qubic node IP from args
    int nodePort = std::atoi(argv[2]);             // Qubic node port from args

    // Determine if we're sending directly to a specific target
    bool sendingDirectly = (argc >= 4);
    const char* targetPubKeyHex = nullptr;

    if (sendingDirectly) {
        targetPubKeyHex = argv[3];
    }

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

    // Initialize target public key if sending directly
    unsigned char targetPublicKey[32] = { 0 };

    if (sendingDirectly) {
        // Convert hex string to binary
        hexToBin(targetPubKeyHex, targetPublicKey, 32);
    }

    // Connect to local solution provider
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

    while (!state) {  // Run until signal handler sets state != 0
        // Receive data from solution provider
        std::string data = solutionClient.receiveLine(solutionClient.sock);

        // Handle connection loss
        if (data.empty()) {
            std::cout << "Connection lost. Reconnecting..." << std::endl;
            solutionClient.closeSocket();

            // Try to reconnect
            if (!solutionClient.connect(solutionProviderIp, solutionProviderPort)) {
                std::this_thread::sleep_for(std::chrono::seconds(5));
                continue;
            }
            std::cout << "Reconnected" << std::endl;
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
                nodeIp,
                nodePort,
                solutionCount
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
