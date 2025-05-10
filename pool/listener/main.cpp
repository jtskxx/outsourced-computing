#include <thread>
#include <chrono>
#include <stdio.h>  
#include <algorithm> 
#include "connection.h"
#include "structs.h"
#include "keyUtils.h"
#include "K12AndKeyUtil.h"
#include "RandomX/src/randomx.h"
#include <stdexcept>
#include <map>
#include <mutex>
#include <queue>
#include <atomic>
#include <vector>
#include <string>
#include <sys/types.h>

// TCP server includes
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
typedef SOCKET socket_t;
#define SOCKET_ERROR_VAL INVALID_SOCKET
#define CLOSE_SOCKET(s) closesocket(s)
typedef int socklen_t;  // socklen_t is not defined in Windows
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
typedef int socket_t;
#define SOCKET_ERROR_VAL -1
#define CLOSE_SOCKET(s) close(s)
#endif

#define DISPATCHER "XPXYKFLGSWRHRGAUKWFWVXCDVEYAPCPCNUTMUDWFGDYQCWZNJMWFZEEGCFFO"
uint8_t dispatcherPubkey[32] = { 0 };
#define PORT 21841
#define TCP_SERVER_PORT 8765  // Port for JSON TCP server
#define SLEEP(x) std::this_thread::sleep_for(std::chrono::milliseconds (x));
bool shouldExit = false;
uint64_t prevTask = 0;

// New variables for reconnection feature
std::mutex lastTaskTimeMutex;
std::chrono::time_point<std::chrono::system_clock> lastTaskTime;
std::atomic<bool> forceReconnect(false);
std::atomic<int> reconnectingThreads(0);
int totalPeerThreads = 0;  // Will be set in run() to argc-1

struct task
{
    uint8_t sourcePublicKey[32]; // the source public key is the DISPATCHER public key
    uint8_t zero[32];  // empty/zero 0
    uint8_t gammingNonce[32];

    uint64_t taskIndex; // ever increasing number (unix timestamp in ms)
    uint16_t firstComputorIndex, lastComputorIndex; // New fields
    uint32_t padding; // New field

    uint8_t m_blob[408]; // Job data from pool
    uint64_t m_size;  // length of the blob
    uint64_t m_target; // Pool difficulty
    uint64_t m_height; // Block height
    uint8_t m_seed[32]; // Seed hash for XMR

    uint8_t signature[64];
};

struct solution
{
    uint8_t sourcePublicKey[32];
    uint8_t zero[32]; // empty/zero 0
    uint8_t gammingNonce[32];

    uint64_t _taskIndex;
    uint16_t firstComputorIndex, lastComputorIndex; // New fields
    
    uint32_t nonce;         // xmrig::JobResult.nonce
    uint8_t result[32];   // xmrig::JobResult.result
    uint8_t signature[64];
};

std::mutex taskLock;
task currentTask;

std::mutex solLock;
std::queue<solution> qSol;
std::map<std::pair<uint64_t, uint32_t>, bool> mTaskNonce; // map task-nonce to avoid duplicated shares
std::atomic<uint64_t> gStale;
std::atomic<uint64_t> gInValid;
std::atomic<uint64_t> gValid;
std::atomic<int> nPeer;
#define XMR_NONCE_POS 39
#define XMR_VERIFY_THREAD 4

// TCP server for JSON broadcasting
std::vector<socket_t> clientSockets;
std::mutex clientSocketsMutex;

// Monitor thread function to detect task reception timeouts
void monitorTaskReception() {
    // Initialize lastTaskTime
    {
        std::lock_guard<std::mutex> lock(lastTaskTimeMutex);
        lastTaskTime = std::chrono::system_clock::now();
    }
    
    while (!shouldExit) {
        bool shouldForceReconnect = false;
        
        {
            std::lock_guard<std::mutex> lock(lastTaskTimeMutex);
            auto now = std::chrono::system_clock::now();
            auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - lastTaskTime).count();
            
            // If more than 60 seconds have passed since the last task, force reconnection
            if (elapsed > 60 && !forceReconnect.load()) {
                printf("WARNING: No tasks received for %ld seconds. Forcing reconnection to all peers.\n", elapsed);
                shouldForceReconnect = true;
            }
        }
        
        if (shouldForceReconnect) {
            forceReconnect.store(true);
            reconnectingThreads.store(totalPeerThreads);
        }
        
        // Check every 5 seconds
        SLEEP(5000);
    }
}

// Send message to all connected clients
void broadcastToClients(const std::string& message) {
    std::lock_guard<std::mutex> lock(clientSocketsMutex);
    std::vector<socket_t> disconnectedClients;

    for (const auto& clientSocket : clientSockets) {
        int result = send(clientSocket, message.c_str(), message.length(), 0);
        if (result <= 0) {
            // Mark this client for removal
            disconnectedClients.push_back(clientSocket);
        }
    }

    // Remove disconnected clients
    for (const auto& socket : disconnectedClients) {
        // Use remove_if with a lambda instead of remove to avoid name conflict
        clientSockets.erase(
            std::remove_if(clientSockets.begin(), clientSockets.end(),
                [&socket](const socket_t& s) { return s == socket; }),
            clientSockets.end()
        );
        CLOSE_SOCKET(socket);
    }
}

// TCP server thread
void tcpServerThread() {
    printf("Starting TCP server on port %d for JSON broadcasting\n", TCP_SERVER_PORT);

#ifdef _WIN32
    // Initialize Winsock
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        printf("Failed to initialize Winsock\n");
        return;
    }
#endif

    // Create a socket
    socket_t serverSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (serverSocket == SOCKET_ERROR_VAL) {
        printf("Failed to create server socket\n");
#ifdef _WIN32
        WSACleanup();
#endif
        return;
    }

    // Allow reuse of address
    int opt = 1;
    setsockopt(serverSocket, SOL_SOCKET, SO_REUSEADDR, (const char*)&opt, sizeof(opt));

    // Bind the socket
    struct sockaddr_in serverAddr;
    serverAddr.sin_family = AF_INET;
    serverAddr.sin_addr.s_addr = INADDR_ANY;
    serverAddr.sin_port = htons(TCP_SERVER_PORT);

    if (bind(serverSocket, (struct sockaddr*)&serverAddr, sizeof(serverAddr)) < 0) {
        printf("Failed to bind server socket\n");
        CLOSE_SOCKET(serverSocket);
#ifdef _WIN32
        WSACleanup();
#endif
        return;
    }

    // Listen for connections
    if (listen(serverSocket, 5) < 0) {
        printf("Failed to listen on server socket\n");
        CLOSE_SOCKET(serverSocket);
#ifdef _WIN32
        WSACleanup();
#endif
        return;
    }

    printf("TCP server listening on port %d\n", TCP_SERVER_PORT);

    // Set non-blocking mode
#ifdef _WIN32
    u_long mode = 1;
    ioctlsocket(serverSocket, FIONBIO, &mode);
#else
    int flags = fcntl(serverSocket, F_GETFL, 0);
    fcntl(serverSocket, F_SETFL, flags | O_NONBLOCK);
#endif

    // Accept client connections
    while (!shouldExit) {
        struct sockaddr_in clientAddr;
        socklen_t clientAddrLen = sizeof(clientAddr);
        socket_t clientSocket = accept(serverSocket, (struct sockaddr*)&clientAddr, &clientAddrLen);

        if (clientSocket != SOCKET_ERROR_VAL) {
            printf("New client connected: %s\n", inet_ntoa(clientAddr.sin_addr));

            // Add client to the list
            std::lock_guard<std::mutex> lock(clientSocketsMutex);
            clientSockets.push_back(clientSocket);
        }

        SLEEP(100);  // Short sleep to prevent busy-waiting
    }

    // Cleanup
    {
        std::lock_guard<std::mutex> lock(clientSocketsMutex);
        for (const auto& clientSocket : clientSockets) {
            CLOSE_SOCKET(clientSocket);
        }
        clientSockets.clear();
    }

    CLOSE_SOCKET(serverSocket);

#ifdef _WIN32
    WSACleanup();
#endif
}

void verifyThread()
{
    task local_task;
    memset(&local_task, 0, sizeof(task));
    randomx_flags flags = randomx_get_flags();
    randomx_cache* cache = randomx_alloc_cache(flags);
    if (cache == nullptr) {
        printf("Failed to allocate RandomX cache\n");
        return;
    }
    randomx_init_cache(cache, local_task.m_seed, 32);
    randomx_vm* vm = randomx_create_vm(flags, cache, NULL);
    if (vm == nullptr) {
        printf("Failed to create RandomX VM\n");
        randomx_release_cache(cache);
        return;
    }
    while (currentTask.taskIndex == 0) SLEEP(100); // wait for the first job

    while (!shouldExit)
    {
        if (local_task.taskIndex != currentTask.taskIndex)
        {
            if (memcmp(local_task.m_seed, currentTask.m_seed, 32) != 0)
            {
                randomx_init_cache(cache, currentTask.m_seed, 32);
                randomx_vm_set_cache(vm, cache);
            }
            local_task = currentTask;
        }
        solution candidate;
        bool haveSol = false;
        {
            std::lock_guard<std::mutex> sl(solLock);
            if (!qSol.empty())
            {
                candidate = qSol.front();
                qSol.pop();
                haveSol = true;
            }

            // clean the key that has lower task index
            if (!mTaskNonce.empty())
            {
                std::vector<std::pair<uint64_t, uint32_t>> to_be_delete;
                for (auto const& item : mTaskNonce)
                {
                    if (item.first.first < currentTask.taskIndex)
                    {
                        to_be_delete.push_back(item.first);
                    }
                }
                for (auto const& item : to_be_delete)
                {
                    mTaskNonce.erase(item);
                }
            }
        }
        if (haveSol)
        {
            if (candidate._taskIndex < local_task.taskIndex)
            {
                gStale.fetch_add(1);
                continue;
            }
            else if (candidate._taskIndex > local_task.taskIndex)
            {
                continue;
            }
            
            // Check if the nonce is from a valid computor index range
            uint32_t nonce = candidate.nonce;
            
            // Verify that computor indices match
            if (candidate.firstComputorIndex != local_task.firstComputorIndex || 
                candidate.lastComputorIndex != local_task.lastComputorIndex) {
                gInValid.fetch_add(1);
                continue;
            }
            
            uint8_t out[32];
            std::vector<uint8_t> blob;
            blob.resize(local_task.m_size, 0);
            memcpy(blob.data(), local_task.m_blob, local_task.m_size);
            memcpy(blob.data() + XMR_NONCE_POS, &nonce, 4);
            randomx_calculate_hash(vm, blob.data(), local_task.m_size, out);
            uint64_t v = ((uint64_t*)out)[3];

            if (v < local_task.m_target)
            {
                gValid.fetch_add(1);
            }
            else
            {
                gInValid.fetch_add(1);
            }
        }
        else
        {
            SLEEP(100);
        }
    }

    randomx_destroy_vm(vm);
    randomx_release_cache(cache);
}

void listenerThread(char* nodeIp)
{
    QCPtr qc;
    bool needReconnect = true;
    bool wasForceReconnected = false;
    std::string log_header = "[" + std::string(nodeIp) + "]: ";
    while (!shouldExit)
    {
        try {
            // Check if we need to force reconnection
            if (forceReconnect.load() && !wasForceReconnected) {
                printf("%sForcing reconnection due to task timeout\n", log_header.c_str());
                needReconnect = true;
                wasForceReconnected = true;
            }
            
            if (needReconnect) {
                // Only increment peer count if this is not a forced reconnection
                if (!wasForceReconnected) {
                    nPeer.fetch_add(1);
                }
                
                needReconnect = false;
                qc = make_qc(nodeIp, PORT);
                qc->exchangePeer();// do the handshake stuff
                
                // If this was a forced reconnection
                if (wasForceReconnected) {
                    int remaining = reconnectingThreads.fetch_sub(1) - 1;
                    
                    // If this was the last thread to reconnect, reset the force flag
                    if (remaining == 0) {
                        forceReconnect.store(false);
                        printf("All peers have been reconnected.\n");
                        
                        // Reset the last task time to now
                        std::lock_guard<std::mutex> timelock(lastTaskTimeMutex);
                        lastTaskTime = std::chrono::system_clock::now();
                    }
                    
                    wasForceReconnected = false;
                }
            }
            
            auto header = qc->receiveHeader();
            std::vector<uint8_t> buff;
            uint32_t sz = header.size();
            if (sz > 0xFFFFFF)
            {
                needReconnect = true;
                if (!wasForceReconnected) {
                    nPeer.fetch_add(-1);
                }
                continue;
            }
            sz -= sizeof(RequestResponseHeader);
            buff.resize(sz);
            qc->receiveData(buff.data(), sz);
            if (header.type() == 1) // broadcast msg
            {
                if (buff.size() == sizeof(solution))
                {
                    solution* share = (solution*)buff.data();
                    char iden[64] = { 0 };
                    getIdentityFromPublicKey(share->sourcePublicKey, iden, false);
                    uint8_t sharedKeyAndGammingNonce[64];
                    memset(sharedKeyAndGammingNonce, 0, 32);
                    memcpy(&sharedKeyAndGammingNonce[32], share->gammingNonce, 32);
                    uint8_t gammingKey[32];
                    KangarooTwelve(sharedKeyAndGammingNonce, 64, gammingKey, 32);


                    if (gammingKey[0] != 2)
                    {
                        continue;
                    }
                    {
                        std::lock_guard<std::mutex> slock(solLock);
                        auto p = std::make_pair(share->_taskIndex, share->nonce);
                        if (mTaskNonce.find(p) == mTaskNonce.end())
                        {
                            mTaskNonce[p] = true;
                            qSol.push(*share);
                        }
                    }
                }
                else if (buff.size() == sizeof(task))
                {
                    task* tk = (task*)buff.data();
                    if (memcmp(dispatcherPubkey, tk->sourcePublicKey, 32) != 0)
                    {
                        continue;
                    }
                    uint8_t sharedKeyAndGammingNonce[64];
                    memset(sharedKeyAndGammingNonce, 0, 32);
                    memcpy(&sharedKeyAndGammingNonce[32], tk->gammingNonce, 32);
                    uint8_t gammingKey[32];
                    KangarooTwelve(sharedKeyAndGammingNonce, 64, gammingKey, 32);
                    if (gammingKey[0] != 1)
                    {
                        continue;
                    }
                    uint8_t digest[32];
                    KangarooTwelve(buff.data(), buff.size() - 64, digest, 32);
                    if (!verify(dispatcherPubkey, digest, buff.data() + buff.size() - 64))
                    {
                        continue;
                    }
                    {
                        std::lock_guard<std::mutex> glock(taskLock);
                        if (currentTask.taskIndex < tk->taskIndex)
                        {
                            currentTask = *tk;
                            
                            // Update the last task time whenever a new task is received
                            std::lock_guard<std::mutex> timelock(lastTaskTimeMutex);
                            lastTaskTime = std::chrono::system_clock::now();
                        }
                        else
                        {
                            continue;
                        }
                    }
                    uint64_t delta = 0;
                    int64_t delta_local = 0;
                    {
                        auto now = std::chrono::system_clock::now();
                        auto duration = now.time_since_epoch();
                        auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(duration).count();
                        delta_local = (int64_t)(tk->taskIndex) - (int64_t)(milliseconds);
                    }
                    if (prevTask)
                    {
                        delta = (tk->taskIndex - prevTask);
                    }
                    prevTask = tk->taskIndex;

                    auto now = std::chrono::system_clock::now();
                    auto now_time_t = std::chrono::system_clock::to_time_t(now);
                    struct tm tm_now;
#ifdef _WIN32
                    localtime_s(&tm_now, &now_time_t);
#else
                    localtime_r(&now_time_t, &tm_now);
#endif
                    char time_str[32];
                    strftime(time_str, sizeof(time_str), "%Y-%m-%d %H:%M:%S", &tm_now);

                    std::string debug_log = log_header;
                    debug_log += std::string(time_str) + "\n";

                    // Prepare hex strings for blob and seed hash
                    char hexBlob[1024] = { 0 };  // Make sure this is large enough for the entire blob
                    byteToHex(tk->m_blob, hexBlob, tk->m_size);
                    char hexSeed[65] = { 0 };
                    byteToHex(tk->m_seed, hexSeed, 32);

                    // Updated target value 
                    char hexTarget[17] = "780D7F02F3220000";

                    // Format the JSON
                    char jsonOutput[2048];
                    snprintf(jsonOutput, sizeof(jsonOutput),
                        "{\n"
                        "    \"id\": \"%lu\",\n"
                        "    \"jsonrpc\": \"2.0\",\n"
                        "    \"method\": \"job\",\n"
                        "    \"job\": {\n"
                        "        \"blob\": \"%s\",\n"
                        "        \"job_id\": \"%lu\",\n"
                        "        \"target\": \"%s\",\n"
                        "        \"algo\": \"rx/0\",\n"
                        "        \"height\": %lu,\n"
                        "        \"seed_hash\": \"%s\",\n"
                        "        \"first_computor_index\": %u,\n"
                        "        \"last_computor_index\": %u\n"
                        "    },\n"
                        "    \"extensions\": [\"algo\", \"height\", \"seed_hash\", \"first_computor_index\", \"last_computor_index\"]\n"
                        "}\n",
                        (unsigned long)tk->taskIndex,
                        hexBlob,
                        (unsigned long)tk->taskIndex,
                        hexTarget,
                        (unsigned long)tk->m_height,
                        hexSeed,
                        tk->firstComputorIndex,
                        tk->lastComputorIndex
                    );

                    debug_log += std::string(jsonOutput);

                    // Optional: Add time delta information as a comment
                    char dbg[256] = { 0 };
                    snprintf(dbg, sizeof(dbg), "// Time Info: (d_prev: %lu ms) (d_local: %ld ms)\n",
                        (unsigned long)delta, (long)delta_local);
                    debug_log += std::string(dbg);

                    printf("%s\n", debug_log.c_str());

                    // Broadcast the JSON to all connected TCP clients
                    std::string jsonMessage = std::string(jsonOutput);
                    broadcastToClients(jsonMessage);
                }
            }
            fflush(stdout);
        }
        catch (std::logic_error& ex) {
            needReconnect = true;
            if (!wasForceReconnected) {
                nPeer.fetch_add(-1);
            }
            wasForceReconnected = false;
            SLEEP(1000);
        }
    }
}

int run(int argc, char* argv[]) {
    if (argc == 1) {
        printf("./oc_verifier [nodeip0] [nodeip1] ... [nodeipN]\n");
        return 0;
    }
    getPublicKeyFromIdentity(DISPATCHER, dispatcherPubkey);
    
    // Set the total number of peer threads
    totalPeerThreads = argc - 1;

    // Start TCP server thread for JSON broadcasting
    std::thread tcpServer(tcpServerThread);
    
    // Start monitor thread to check for task timeouts
    std::thread monitorThread(monitorTaskReception);

    std::vector<std::thread> thr;
    for (int i = 0; i < argc - 1; i++)
    {
        thr.push_back(std::thread(listenerThread, argv[1 + i]));
    }

    std::thread verify_thr[XMR_VERIFY_THREAD];
    for (int i = 0; i < XMR_VERIFY_THREAD; i++)
    {
        verify_thr[i] = std::thread(verifyThread);
    }

    SLEEP(3000);
    while (!shouldExit)
    {
        SLEEP(10000);
    }

    // Wait for all threads to exit
    tcpServer.join();
    monitorThread.join();  // Wait for monitor thread

    for (auto& t : thr) {
        if (t.joinable()) {
            t.join();
        }
    }

    for (int i = 0; i < XMR_VERIFY_THREAD; i++) {
        if (verify_thr[i].joinable()) {
            verify_thr[i].join();
        }
    }

    return 0;
}

int main(int argc, char* argv[]) {
    gStale = 0;
    gInValid = 0;
    gValid = 0;
    nPeer = 0;
    try {
        return run(argc, argv);
    }
    catch (std::exception& ex) {
        printf("%s\n", ex.what());
        return -1;
    }
}
