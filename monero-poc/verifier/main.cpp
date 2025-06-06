#include <thread>
#include <chrono>
#include "stdio.h"
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
#include <sstream>
#include <iostream>
#include <csignal>
#include <set>
#include <algorithm>
#include <iomanip>

#define DISPATCHER "XPXYKFLGSWRHRGAUKWFWVXCDVEYAPCPCNUTMUDWFGDYQCWZNJMWFZEEGCFFO"
uint8_t dispatcherPubkey[32] = {0};
uint8_t operatorSeed[56] = {0};
uint8_t operatorPublicKey[32] = {0};
uint8_t operatorSubSeed[32]= {0};
uint8_t operatorPrivateKey[32]= {0};
char operatorPublicIdentity[128] = {0};

#define DUMMY_TEST 0
std::mutex gDummyLock;
unsigned long long gDummyCounter = 0;

constexpr uint16_t NUMBER_OF_TASK_PARTITIONS = 4;
struct
{
    uint16_t firstComputorIdx;
    uint16_t lastComputorIdx;
    uint32_t domainSize;
} gTaskPartition[NUMBER_OF_TASK_PARTITIONS];
uint16_t gComputorPartitionMap[NUMBER_OF_COMPUTORS];

// Add tracking for specific computor indices
std::set<int> gTrackedIndices;
std::mutex gTrackedStatsLock;
std::map<int, uint64_t> gTrackedValid;
std::map<int, uint64_t> gTrackedInvalid;
std::map<int, uint64_t> gTrackedStale;

#if DUMMY_TEST
#define OPERATOR_PORT 31841
#else
#define OPERATOR_PORT 21841
#endif

#define PORT 21841
#define SLEEP(x) std::this_thread::sleep_for(std::chrono::milliseconds (x));
bool shouldExit = false;
uint64_t prevTask[NUMBER_OF_TASK_PARTITIONS] = {0};

struct task
{
    uint8_t sourcePublicKey[32]; // the source public key is the DISPATCHER public key
    uint8_t zero[32];  // empty/zero 0
    uint8_t gammingNonce[32];

    uint64_t taskIndex; // ever increasing number (unix timestamp in ms)
    uint16_t firstComputorIndex, lastComputorIndex;
    uint32_t padding;

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
    uint16_t firstComputorIndex, lastComputorIndex;

    uint32_t nonce;         // xmrig::JobResult.nonce
    uint8_t result[32];   // xmrig::JobResult.result
    uint8_t signature[64];
} ;

struct XMRTask
{
    uint64_t taskIndex; // ever increasing number (unix timestamp in ms)
    uint16_t firstComputorIndex, lastComputorIndex;
    uint32_t padding;

    uint8_t m_blob[408]; // Job data from pool
    uint64_t m_size;  // length of the blob
    uint64_t m_target; // Pool difficulty
    uint64_t m_height; // Block height
    uint8_t m_seed[32]; // Seed hash for XMR

    task convertToTask()
    {
        task tk;

        tk.taskIndex = taskIndex;
        tk.firstComputorIndex = firstComputorIndex;
        tk.lastComputorIndex = lastComputorIndex;
        memcpy(tk.m_blob, m_blob, 408);
        tk.m_size = m_size;
        tk.m_target = m_target;
        tk.m_height = m_height;
        memcpy(tk.m_seed, m_seed, 32);
        return tk;
    }
};

struct XMRSolution
{
    uint64_t taskIndex;
    uint16_t firstComputorIndex, lastComputorIndex;

    uint32_t nonce;         // xmrig::JobResult.nonce
    uint8_t result[32];     // xmrig::JobResult.result

    solution convertToSol()
    {
        solution sol;
        sol._taskIndex = taskIndex;
        sol.firstComputorIndex = firstComputorIndex;
        sol.lastComputorIndex = lastComputorIndex;

        sol.nonce = nonce;
        memcpy(sol.result, result, 32);
        return sol;
    }
};

struct RequestedCustomMiningData
{
    enum
    {
        type = 60,
    };
    enum
    {
        taskType = 0,
        solutionType = 1,
    };

    unsigned long long fromTaskIndex;
    unsigned long long toTaskIndex;

    // Determine which task partition
    unsigned short firstComputorIdx;
    unsigned short lastComputorIdx;
    unsigned int padding;

    long long dataType;
};

struct RespondCustomMiningData
{
    enum
    {
        type = 61,
    };
    enum
    {
        taskType = 0,
        solutionType = 1,
    };
};

struct RequestedCustomMiningSolutionVerification
{
    enum
    {
        type = 62,
    };
    unsigned long long taskIndex;
    unsigned short firstComputorIndex, lastComputorIndex;
    unsigned int nonce; // nonce of invalid solution
    unsigned long long isValid; // validity of the solution
};

struct RespondCustomMiningSolutionVerification
{
    enum
    {
        type = 63,
    };
    enum
    {
        notExisted = 0,             // solution not existed in cache
        valid = 1,                  // solution are set as valid
        invalid = 2,                // solution are set as invalid
        customMiningStateEnded = 3, // not in custom mining state
    };
    unsigned long long taskIndex;
    unsigned short firstComputorIndex, lastComputorIndex;
    unsigned int nonce;
    long long status;   // Flag indicate the status of solution
};

struct CustomMiningRespondDataHeader
{
    unsigned long long itemCount;       // size of the data
    unsigned long long itemSize;        // size of the data
    unsigned long long fromTimeStamp;   // start of the ts
    unsigned long long toTimeStamp;     // end of the ts
    unsigned long long respondType;     // message type
};

// simple poc design and queue, need better design to have higher precision
std::mutex taskLock[NUMBER_OF_TASK_PARTITIONS];
task currentTask[NUMBER_OF_TASK_PARTITIONS];

std::mutex solLock[NUMBER_OF_TASK_PARTITIONS];
std::queue<solution> qSol[NUMBER_OF_TASK_PARTITIONS];
std::map<std::pair<uint64_t, uint32_t>, bool> mTaskNonce[NUMBER_OF_TASK_PARTITIONS]; // map task-nonce to avoid duplicated shares
std::atomic<uint64_t> gStale;
std::atomic<uint64_t> gInValid;
std::atomic<uint64_t> gValid;
std::atomic<int> nPeer;

std::mutex gValidSolLock;
std::vector<RequestedCustomMiningSolutionVerification> gReportedSolutionsVec;
std::atomic<uint64_t> gSubmittedSols(0);
std::map<uint64_t, XMRTask> nodeTasks; // Task that fetching from node
std::map<uint64_t, std::vector<XMRSolution>> nodeSolutions; // Solutions that fetching from node

#define XMR_NONCE_POS 39
#define XMR_VERIFY_THREAD 4

void getKey()
{
    getSubseedFromSeed((unsigned char*)operatorSeed, operatorSubSeed);
    getPrivateKeyFromSubSeed(operatorSubSeed, operatorPrivateKey);
    getPublicKeyFromPrivateKey(operatorPrivateKey, operatorPublicKey);
    getIdentityFromPublicKey(operatorPublicKey, operatorPublicIdentity, false);
}

// Get the ID of the this solutions
int getPartitionID(uint16_t firstComputorIndex, uint16_t lastComputorIndex)
{
    int partitionID = -1;
    for (int k = 0; k < NUMBER_OF_TASK_PARTITIONS; k++)
    {
        if (firstComputorIndex == gTaskPartition[k].firstComputorIdx
            && lastComputorIndex == gTaskPartition[k].lastComputorIdx)
        {
            partitionID = k;
            break;
        }
    }
    return partitionID;
}

int getComputorID(uint32_t nonce, int partId)
{
    return nonce / gTaskPartition[partId].domainSize + gTaskPartition[partId].firstComputorIdx;
}

// Function to update tracked statistics
void updateTrackedStats(int computorId, bool isValid, bool isStale)
{
    if (gTrackedIndices.find(computorId) != gTrackedIndices.end())
    {
        std::lock_guard<std::mutex> lock(gTrackedStatsLock);
        if (isStale)
        {
            gTrackedStale[computorId]++;
        }
        else if (isValid)
        {
            gTrackedValid[computorId]++;
        }
        else
        {
            gTrackedInvalid[computorId]++;
        }
    }
}

// Function to prompt for computor indices to track
void promptForTrackedIndices()
{
    std::cout << "\n=== COMPUTOR INDEX TRACKING SETUP ===" << std::endl;
    std::cout << "Enter computor indices to track (separated by spaces or commas)." << std::endl;
    std::cout << "Valid range is 0-" << (NUMBER_OF_COMPUTORS - 1) << std::endl;
    std::cout << "Example: 0 1 5 10 or 0,1,5,10" << std::endl;
    std::cout << "Enter indices: ";
    
    std::string input;
    std::getline(std::cin, input);
    
    // Replace commas with spaces
    std::replace(input.begin(), input.end(), ',', ' ');
    
    std::istringstream iss(input);
    int index;
    while (iss >> index)
    {
        if (index >= 0 && index < NUMBER_OF_COMPUTORS)
        {
            gTrackedIndices.insert(index);
            gTrackedValid[index] = 0;
            gTrackedInvalid[index] = 0;
            gTrackedStale[index] = 0;
        }
        else
        {
            std::cout << "Warning: Index " << index << " is out of range (0-" << (NUMBER_OF_COMPUTORS - 1) << "). Skipping." << std::endl;
        }
    }
    
    if (gTrackedIndices.empty())
    {
        std::cout << "No valid indices entered. Tracking will be disabled." << std::endl;
    }
    else
    {
        std::cout << "Tracking indices: ";
        for (const auto& idx : gTrackedIndices)
        {
            std::cout << idx << " ";
        }
        std::cout << std::endl;
    }
}

// Function to print tracked statistics
void printTrackedStats()
{
    if (gTrackedIndices.empty())
    {
        return;
    }
    
    std::lock_guard<std::mutex> lock(gTrackedStatsLock);
    std::cout << "\n=== TRACKED COMPUTOR STATISTICS ===" << std::endl;
    std::cout << "Index | Valid | Invalid | Stale" << std::endl;
    std::cout << "------|-------|---------|------" << std::endl;
    
    for (const auto& idx : gTrackedIndices)
    {
        std::cout << std::setw(5) << idx << " | " 
                  << std::setw(5) << gTrackedValid[idx] << " | " 
                  << std::setw(7) << gTrackedInvalid[idx] << " | " 
                  << std::setw(5) << gTrackedStale[idx] << std::endl;
    }
    std::cout << "=====================================" << std::endl;
}

bool reportVerifiedSol(QCPtr pConnection)
{
    bool haveSolsToReport = false;
    RequestedCustomMiningSolutionVerification verifiedSol;
    {
        {
            std::lock_guard<std::mutex> validLock(gValidSolLock);
            if (!gReportedSolutionsVec.empty())
            {
                verifiedSol = gReportedSolutionsVec.front();
                haveSolsToReport = true;
            }
        }

        // Submit the validated solutions
        if (haveSolsToReport)
        {
            struct {
                RequestResponseHeader header;
                RequestedCustomMiningSolutionVerification verifiedSol;
                uint8_t signature[SIGNATURE_SIZE];
            } packet;

            // Header
            packet.header.setSize(sizeof(packet));
            packet.header.randomizeDejavu();
            packet.header.setType(RequestedCustomMiningSolutionVerification::type);

            // Payload
            packet.verifiedSol = verifiedSol;

            // Sign the message
            uint8_t digest[32] = {0};
            uint8_t signature[64] = {0};
            KangarooTwelve(
                (unsigned char*)&packet.verifiedSol,
                sizeof(packet.verifiedSol),
                digest,
                32);
            sign(operatorSubSeed, operatorPublicKey, digest, signature);
            memcpy(packet.signature, signature, 64);

            // Send data
            int dataSent = pConnection->sendData((uint8_t*)&packet, sizeof(packet));

            // Send successfull, erase it from the invalid queue
            if (dataSent == sizeof(packet))
            {
                struct {
                    RequestResponseHeader header;
                    RespondCustomMiningSolutionVerification verifiedSol;
                } respondPacket;

                int dataRev = pConnection->receiveData((uint8_t*)&respondPacket, sizeof(respondPacket));
                if (dataRev > 0)
                {
                    // TODO: process respond here.
                }

                // Repsond is good. Remove the submitted sol
                std::lock_guard<std::mutex> validLock(gValidSolLock);
                if (!gReportedSolutionsVec.empty())
                {
                    gReportedSolutionsVec.erase(gReportedSolutionsVec.begin());
                    gSubmittedSols.fetch_add(1);
                }

            }
        }
    }
    return haveSolsToReport;
}

void submitVerifiedSolution(const char* nodeIp)
{
    QCPtr qc;
    bool needReconnect = true;
    std::string log_header = "[" + std::string(nodeIp) + "]: ";
    while (!shouldExit)
    {
        try {
            if (needReconnect)
            {
                needReconnect = false;
                qc = make_qc(nodeIp, OPERATOR_PORT);
                qc->exchangePeer();// do the handshake stuff
                printf("%sConnected OPERATOR node %s\n", log_header.c_str(), nodeIp);
            }

            bool haveSolsToSubmited = reportVerifiedSol(qc);
            if (!haveSolsToSubmited)
            {
                SLEEP(1000);
            }
        }
        catch (std::logic_error &ex) {
            printf("%s\n", ex.what());
            fflush(stdout);
            needReconnect = true;
            nPeer.fetch_add(-1);;
            SLEEP(1000);
        }
        catch (...)
        {
            printf("Unknown exception caught!\n");
            fflush(stdout);
            needReconnect = true;
            nPeer.fetch_add(-1);
            SLEEP(1000);
        }
    }
}

void verifyThread(int taskGroupID)
{
    task local_task;
    memset(&local_task, 0, sizeof(task));
    randomx_flags flags = randomx_get_flags();
    randomx_cache *cache = randomx_alloc_cache(flags);
    randomx_init_cache(cache, local_task.m_seed, 32);
    randomx_vm *vm = randomx_create_vm(flags, cache, NULL);
    while (currentTask[taskGroupID].taskIndex == 0) SLEEP(100); // wait for the first job

    while (!shouldExit)
    {
        if (local_task.taskIndex != currentTask[taskGroupID].taskIndex)
        {
            if (memcmp(local_task.m_seed, currentTask[taskGroupID].m_seed, 32) != 0)
            {
                randomx_init_cache(cache, currentTask[taskGroupID].m_seed, 32);
                randomx_vm_set_cache(vm, cache);
            }
            local_task = currentTask[taskGroupID];
        }
        solution candidate;
        bool haveSol = false;
        {
            std::lock_guard<std::mutex> sl(solLock[taskGroupID]);
            if (!qSol[taskGroupID].empty())
            {
                candidate = qSol[taskGroupID].front();
                qSol[taskGroupID].pop();
                haveSol = true;
            }

            // clean the key that has lower task index
            if (!mTaskNonce[taskGroupID].empty())
            {
                std::vector<std::pair<uint64_t,uint32_t>> to_be_delete;
                for (auto const& item : mTaskNonce[taskGroupID])
                {
                    if (item.first.first < currentTask[taskGroupID].taskIndex)
                    {
                        to_be_delete.push_back(item.first);
                    }
                }
                for (auto const& item : to_be_delete)
                {
                    mTaskNonce[taskGroupID].erase(item);
                }
            }
        }
        if (haveSol)
        {
            int computorId = getComputorID(candidate.nonce, taskGroupID);
            if (computorId > candidate.lastComputorIndex)
            {
                printf("Nonce is out of range  want <= %d | have %d\n", candidate.lastComputorIndex, computorId);
                continue;
            }

            if (candidate._taskIndex < local_task.taskIndex)
            {
                gStale.fetch_add(1);
                updateTrackedStats(computorId, false, true); // Update tracked stats for stale
                printf("Stale Share from comp %d\n", computorId);
                continue;
            }
            else if (candidate._taskIndex > local_task.taskIndex)
            {
                printf("Do not expected: Missing task - check your peers\n");
                continue;
            }
            uint8_t out[32];
            std::vector<uint8_t> blob;
            blob.resize(local_task.m_size, 0);
            memcpy(blob.data(), local_task.m_blob, local_task.m_size);
            uint32_t nonce = candidate.nonce;
            memcpy(blob.data() + XMR_NONCE_POS, &nonce, 4);
            randomx_calculate_hash(vm, blob.data(), local_task.m_size, out);
            uint64_t v = ((uint64_t*)out)[3];
            char hex[64];
            byteToHex(out, hex, 32);

            RequestedCustomMiningSolutionVerification verifedSol;
            verifedSol.nonce = candidate.nonce;
            verifedSol.taskIndex = local_task.taskIndex;
            //verifedSol.padding = candidate.padding;

            if (v < local_task.m_target)
            {
                verifedSol.isValid = 1;
                gValid.fetch_add(1);
                updateTrackedStats(computorId, true, false); // Update tracked stats for valid
                printf("Valid Share from comp %d: %s\n", computorId, hex);
            }
            else
            {
                // Save the solution for sending to node this is an invalidate solutions
                {
                    std::lock_guard<std::mutex> validLock(gValidSolLock);
                    verifedSol.isValid = 0;
                }
                gInValid.fetch_add(1);
                updateTrackedStats(computorId, false, false); // Update tracked stats for invalid
                printf("Invalid Share from comp %d: %s\n", computorId, hex);
            }
            gReportedSolutionsVec.push_back(verifedSol);
        }
        else
        {
            SLEEP(100);
        }
    }

    randomx_destroy_vm(vm);
    randomx_release_cache(cache);
}

void listenerThread(const char* nodeIp)
{
    QCPtr qc;
    bool needReconnect = true;
    std::string log_header = "[" + std::string(nodeIp) + "]: ";
    while (!shouldExit)
    {
        try {
            if (needReconnect) {
                needReconnect = false;
                nPeer.fetch_add(1);
                qc = make_qc(nodeIp, PORT);
                qc->exchangePeer();// do the handshake stuff
                // TODO: connect to received peers
                printf("Connected to %s\n", nodeIp);
            }
            auto header = qc->receiveHeader();
            std::vector<uint8_t> buff;
            uint32_t sz = header.size();
            if (sz > 0xFFFFFF)
            {
                needReconnect = true;
                nPeer.fetch_add(-1);
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
                    char iden[64] = {0};
                    getIdentityFromPublicKey(share->sourcePublicKey, iden, false);
                    uint8_t sharedKeyAndGammingNonce[64];
                    memset(sharedKeyAndGammingNonce, 0, 32);
                    memcpy(&sharedKeyAndGammingNonce[32], share->gammingNonce, 32);
                    uint8_t gammingKey[32];
                    KangarooTwelve(sharedKeyAndGammingNonce, 64, gammingKey, 32);

                    uint8_t digest[32];
                    KangarooTwelve(buff.data(), buff.size() - 64, digest, 32);
                    if (!verify(share->sourcePublicKey, digest, buff.data() + buff.size() - 64))
                    {
                        printf("Wrong sig from computor %s\n", iden);
                        continue;
                    }

                    // Get the ID of the this solutions
                    int partId =  getPartitionID(share->firstComputorIndex, share->lastComputorIndex);
                    if (partId < 0)
                    {
                        continue;
                    }
                    int computorNonceID = getComputorID(share->nonce, partId);
                    if (computorNonceID > share->lastComputorIndex)
                    {
                        printf("Nonce is out of range from comps (%s) want <= %d | have %d\n", iden, share->lastComputorIndex, computorNonceID);
                        continue;
                    }

                    if (gammingKey[0] != 2)
                    {
                        printf("Wrong type from comps (%s) No.%d. want %d | have %d\n", iden, computorNonceID, 2, gammingKey[0]);
                        continue;
                    }

                    {
                        std::lock_guard<std::mutex> slock(solLock[partId]);
                        auto p = std::make_pair(share->_taskIndex, share->nonce);
                        if (mTaskNonce[partId].find(p) == mTaskNonce[partId].end())
                        {
                            mTaskNonce[partId][p] = true;
                            qSol[partId].push(*share);
                        }
                    }
                }
                else if (buff.size() == sizeof(task))
                {
                    task* tk = (task*)buff.data();
                    if (memcmp(dispatcherPubkey, tk->sourcePublicKey, 32) != 0)
                    {
                        printf("Job not from dispatcher\n");
                        continue;
                    }
                    uint8_t sharedKeyAndGammingNonce[64];
                    memset(sharedKeyAndGammingNonce, 0, 32);
                    memcpy(&sharedKeyAndGammingNonce[32], tk->gammingNonce, 32);
                    uint8_t gammingKey[32];
                    KangarooTwelve(sharedKeyAndGammingNonce, 64, gammingKey, 32);
                    if (gammingKey[0] != 1)
                    {
                        printf("Wrong type from dispatcher\n");
                        continue;
                    }
                    uint8_t digest[32];
                    KangarooTwelve(buff.data(), buff.size() - 64, digest, 32);
                    if (!verify(dispatcherPubkey, digest, buff.data() + buff.size() - 64))
                    {
                        printf("Wrong sig from dispatcher\n");
                        continue;
                    }
                    // Get the ID of the this solutions
                    int partId =  getPartitionID(tk->firstComputorIndex, tk->lastComputorIndex);
                    if (partId < 0)
                    {
                        continue;
                    }

                    {
                        std::lock_guard<std::mutex> glock(taskLock[partId]);
                        if (currentTask[partId].taskIndex <  tk->taskIndex)
                        {
                            currentTask[partId] = *tk;
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
                        // Convert the time point to milliseconds since the epoch (Unix timestamp)
                        auto duration = now.time_since_epoch();
                        auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(duration).count();
                        delta_local = (int64_t)(tk->taskIndex) - (int64_t)(milliseconds);
                    }
                    if (prevTask[partId])
                    {
                        delta = (tk->taskIndex - prevTask[partId]);
                    }
                    prevTask[partId] = tk->taskIndex;
                    char dbg[256] = {0};
                    std::string debug_log = log_header;
                    sprintf(dbg, "Received task index %lu, firstIdx %d, lastIdx %d (d_prev: %lu ms) (d_local: %lu ms): ", tk->taskIndex, tk->firstComputorIndex, tk->lastComputorIndex, delta, delta_local);
                    debug_log += std::string(dbg); memset(dbg, 0, sizeof(dbg));
                    int blobSz = tk->m_size;
                    for (int i = 0; i < 4; i++)
                    {
                        char hex[8] = {0};
                        byteToHex(tk->m_blob + i, hex, 1);
                        debug_log += std::string(hex);
                    }
                    debug_log += "...";
                    for (int i = blobSz - 4; i < blobSz; i++)
                    {
                        char hex[8] = {0};
                        byteToHex(tk->m_blob + i, hex, 1);
                        debug_log += std::string(hex);
                    }

                    sprintf(dbg, " | diff %llu", 0xffffffffffffffffULL/tk->m_target);
                    debug_log += std::string(dbg); memset(dbg, 0, sizeof(dbg));
                    sprintf(dbg, " | height %lu\n", tk->m_height);
                    debug_log += std::string(dbg); memset(dbg, 0, sizeof(dbg));
                    printf("%s", debug_log.c_str());
                }
                // TODO: help relaying the messages to connected peers

            }
            fflush(stdout);
        }
        catch (std::logic_error &ex) {
            printf("%s\n", ex.what());
            fflush(stdout);
            needReconnect = true;
            nPeer.fetch_add(-1);
            SLEEP(1000);
        }
        catch (...)
        {
            printf("Unknown exception caught!\n");
            fflush(stdout);
            needReconnect = true;
            nPeer.fetch_add(-1);
            SLEEP(1000);
        }
    }
}

constexpr int64_t OFFSET_TIME_STAMP_IN_MS = 600000;

template <typename T>
void printTaskInfo(T* tk, std::string logHeader)
{
    uint64_t delta = 0;
    int64_t delta_local = 0;
    {
        auto now = std::chrono::system_clock::now();
        // Convert the time point to milliseconds since the epoch (Unix timestamp)
        auto duration = now.time_since_epoch();
        auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(duration).count();
        delta_local = (int64_t)(tk->taskIndex) - (int64_t)(milliseconds);
    }
    // if (prevTask)
    // {
    //     delta = (tk->taskIndex - prevTask);
    // }
    // prevTask = tk->taskIndex;
    char dbg[256] = {0};
    std::string debug_log = logHeader;
    sprintf(dbg, "Received task index %lu (d_prev: %lu ms) (d_local: %lu ms): ", tk->taskIndex, delta, delta_local);
    debug_log += std::string(dbg); memset(dbg, 0, sizeof(dbg));
    int blobSz = tk->m_size;
    for (int i = 0; i < 4; i++)
    {
        char hex[8] = {0};
        byteToHex(tk->m_blob + i, hex, 1);
        debug_log += std::string(hex);
    }
    debug_log += "...";
    for (int i = blobSz - 4; i < blobSz; i++)
    {
        char hex[8] = {0};
        byteToHex(tk->m_blob + i, hex, 1);
        debug_log += std::string(hex);
    }

    sprintf(dbg, " | diff %llu", 0xffffffffffffffffULL/tk->m_target);
    debug_log += std::string(dbg); memset(dbg, 0, sizeof(dbg));
    sprintf(dbg, " | height %lu\n", tk->m_height);
    debug_log += std::string(dbg); memset(dbg, 0, sizeof(dbg));
    printf("%s", debug_log.c_str());
}

static uint64_t lastTaskTimeStamp = 0;

static randomx_flags gRandomXFlags;
static randomx_cache *gRandomXCache;
static randomx_vm * gRandomXVM = NULL;
static uint8_t gRandomXCacheBuff[32];

void initRandomX()
{
    gRandomXFlags = randomx_get_flags();
    gRandomXCache = randomx_alloc_cache(gRandomXFlags);
    randomx_init_cache(gRandomXCache, gRandomXCacheBuff, 32);
    gRandomXVM = randomx_create_vm(gRandomXFlags, gRandomXCache, NULL);
}

void cleanRandomX()
{
    randomx_destroy_vm(gRandomXVM);
    randomx_release_cache(gRandomXCache);
}

void verifySolutionFromNode(const XMRTask& rTask, std::vector<XMRSolution>& rSolutions)
{
    XMRTask local_task = rTask;

    int partId = getPartitionID(rTask.firstComputorIndex, rTask.lastComputorIndex);

    randomx_init_cache(gRandomXCache, local_task.m_seed, 32);
    randomx_vm_set_cache(gRandomXVM, gRandomXCache);

    for (auto& it : rSolutions)
    {
        uint8_t out[32];
        std::vector<uint8_t> blob;
        blob.resize(local_task.m_size, 0);
        memcpy(blob.data(), local_task.m_blob, local_task.m_size);
        uint32_t nonce = it.nonce;
        memcpy(blob.data() + XMR_NONCE_POS, &nonce, 4);
        randomx_calculate_hash(gRandomXVM, blob.data(), local_task.m_size, out);
        uint64_t v = ((uint64_t*)out)[3];
        char hex[64];
        byteToHex(out, hex, 32);
        solution candidate = it.convertToSol();

        #if DUMMY_TEST
        // Dummy test, for each 2 valid solution, the next one will be invalid
        bool dummyInvalid = false;
        {
            std::lock_guard<std::mutex> dummyLock(gDummyLock);
            gDummyCounter++;
            if (gDummyCounter % 4 == 0)
            {
                dummyInvalid = true;
            }
        }
        #endif

        RequestedCustomMiningSolutionVerification verifedSol;
        verifedSol.nonce = candidate.nonce;
        verifedSol.taskIndex = local_task.taskIndex;
        verifedSol.firstComputorIndex = candidate.firstComputorIndex;
        verifedSol.lastComputorIndex = candidate.lastComputorIndex;
        //verifedSol.padding = candidate.padding;

        int computorID = getComputorID(candidate.nonce, partId);
        #if DUMMY_TEST
        if (computorID <= local_task.lastComputorIndex && !dummyInvalid)
        #else
        if (computorID <= local_task.lastComputorIndex && v < local_task.m_target)
        #endif
        {
            verifedSol.isValid = 1;
            gValid.fetch_add(1);
            updateTrackedStats(computorID, true, false); // Update tracked stats for valid
            printf("Valid Share for comp %d: %s\n", computorID, hex);
        }
        else
        {
            verifedSol.isValid = 0;
            gInValid.fetch_add(1);
            updateTrackedStats(computorID, false, false); // Update tracked stats for invalid
            printf("Invalid Share for comp %d: %s\n", computorID, hex);
        }
        // Save the solution for sending to node this is an invalidate solutions
        {
            std::lock_guard<std::mutex> validLock(gValidSolLock);
            gReportedSolutionsVec.push_back(verifedSol);
        }
    }
}

void getCustomMiningSolutions(QCPtr pConnection, const char* logHeader, const std::map<uint64_t, XMRTask>& nodeTask)
{
    nodeSolutions.clear();

    struct {
        RequestResponseHeader header;
        RequestedCustomMiningData requestData;
        unsigned char signature[SIGNATURE_SIZE];
    } packet;

    packet.header.setSize(sizeof(packet));
    packet.header.randomizeDejavu();
    packet.header.setType(RequestedCustomMiningData::type);

    for (const auto& it : nodeTask)
    {
        unsigned long long taskIndex = it.second.taskIndex;
        packet.requestData.dataType = RequestedCustomMiningData::solutionType;
        packet.requestData.fromTaskIndex = taskIndex;
        packet.requestData.firstComputorIdx = it.second.firstComputorIndex;
        packet.requestData.lastComputorIdx = it.second.lastComputorIndex;
        packet.requestData.toTaskIndex = 0; // Unused

        // Sign the message
        uint8_t digest[32] = {0};
        uint8_t signature[64] = {0};
        KangarooTwelve(
            (unsigned char*)&packet.requestData,
            sizeof(RequestedCustomMiningData),
            digest,
            32);
        sign(operatorSubSeed, operatorPublicKey, digest, signature);
        memcpy(packet.signature, signature, 64);

        // Send request solution
        int dataSent = pConnection->sendData((uint8_t*)&packet, sizeof(packet));
        if (dataSent == sizeof(packet))
        {
            // Get the solution
            RequestResponseHeader respond_header = pConnection->receiveHeader();
            // Verified the message
            if (respond_header.type() == RespondCustomMiningData::type)
            {
                if (respond_header.size() > sizeof(RequestResponseHeader))
                {
                    int dataSize = respond_header.size() - sizeof(RequestResponseHeader);
                    std::vector<unsigned char> dataBuffer(dataSize);
                    unsigned char* pData = &dataBuffer[0];
                    int receivedSize = pConnection->receiveData(pData, dataSize);

                    if (receivedSize != dataSize)
                    {
                        continue;
                    }

                    CustomMiningRespondDataHeader respondDataHeader = *(CustomMiningRespondDataHeader*)pData;
                    if (respondDataHeader.itemCount > 0 && respondDataHeader.respondType == RespondCustomMiningData::solutionType)
                    {
                        std::cout << "Found " << respondDataHeader.itemCount
                                  << " shares for task index (" << taskIndex
                                  << ", " << it.second.firstComputorIndex << ", " << it.second.lastComputorIndex << ")"
                                  << std::endl << std::flush;

                        // Push the solutions into queue
                        XMRSolution* pSols = (XMRSolution*)(pData + sizeof(CustomMiningRespondDataHeader));
                        for (int k = 0; k < respondDataHeader.itemCount; k++)
                        {
                            nodeSolutions[taskIndex].push_back(pSols[k]);
                        }

                        // Verified solutions
                        verifySolutionFromNode(it.second, nodeSolutions[taskIndex]);
                    }
                }
            }
        }
    }
}

bool fetchCustomMiningData(QCPtr pConnection, const char* logHeader)
{
    bool haveCustomMiningData = false;
    struct {
        RequestResponseHeader header;
        RequestedCustomMiningData requestData;
        unsigned char signature[SIGNATURE_SIZE];
    } packet;

    packet.header.setSize(sizeof(packet));
    packet.header.randomizeDejavu();
    packet.header.setType(RequestedCustomMiningData::type);

    uint64_t fromTaskIndex = lastTaskTimeStamp;// - OFFSET_TIME_STAMP_IN_MS;
    uint64_t toTaskIndex = 0; // Fetch all the task
    packet.requestData.dataType = RequestedCustomMiningData::taskType;
    packet.requestData.fromTaskIndex = fromTaskIndex;
    packet.requestData.toTaskIndex = toTaskIndex;

    // Sign the message
    uint8_t digest[32] = {0};
    uint8_t signature[64] = {0};
    KangarooTwelve(
        (unsigned char*)&packet.requestData,
        sizeof(RequestedCustomMiningData),
        digest,
        32);
    sign(operatorSubSeed, operatorPublicKey, digest, signature);
    memcpy(packet.signature, signature, 64);

    // Send request all task
    int dataSent = pConnection->sendData((uint8_t*)&packet, sizeof(packet));
    if (dataSent == sizeof(packet))
    {
        // Get the task
        RequestResponseHeader respond_header = pConnection->receiveHeader();
        // Verified the message
        if (respond_header.type() == RespondCustomMiningData::type)
        {
            if (respond_header.size() > sizeof(RequestResponseHeader))
            {
                unsigned int dataSize = respond_header.size() - sizeof(RequestResponseHeader);
                std::vector<unsigned char> dataBuffer(dataSize);
                unsigned char* pData = &dataBuffer[0];
                int receivedSize = pConnection->receiveData(pData, dataSize);

                // Data is failed to rev
                if (receivedSize != dataSize)
                {
                    return false;
                }

                unsigned long long lastReceivedTaskTs = 0;
                CustomMiningRespondDataHeader respondDataHeader = *(CustomMiningRespondDataHeader*)pData;
                if (respondDataHeader.itemCount > 0 && respondDataHeader.respondType == RespondCustomMiningData::taskType)
                {
                    std::vector<XMRTask> taskVec;
                    XMRTask* pTask = (XMRTask*)(pData + sizeof(CustomMiningRespondDataHeader));
                    for (int i = 0; i < respondDataHeader.itemCount; i++)
                    {
                        XMRTask rawTask = pTask[i];

                        lastReceivedTaskTs = rawTask.taskIndex;
                        //printTaskInfo<XMRTask>(&rawTask, logHeader);
                        task tk = rawTask.convertToTask();
                        // Update the task
                        nodeTasks[rawTask.taskIndex] = rawTask;
                    }

                    // Remove too late task
                    auto now = std::chrono::system_clock::now();
                    auto duration = now.time_since_epoch();
                    auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(duration).count();
                    for (auto it = nodeTasks.begin(); it != nodeTasks.end(); )
                    {
                        if (std::abs((int64_t)it->first - (int64_t)(milliseconds) > OFFSET_TIME_STAMP_IN_MS))
                        {
                            it = nodeTasks.erase(it);
                        }
                        else
                        {
                            ++it;
                        }
                    }

                    // From current active task. Try to fetch solutions/shares of the task
                    getCustomMiningSolutions(pConnection, logHeader, nodeTasks);

                    // Update the last time stamp
                    if (lastReceivedTaskTs > 0)
                    {
                        lastTaskTimeStamp = lastReceivedTaskTs + 1;
                    }
                    else
                    {
                        lastReceivedTaskTs = lastReceivedTaskTs + 10000;
                    }
                }
            }
        }
    }

    return haveCustomMiningData;
}

void operatorFetcherThread(const char* nodeIp)
{
    QCPtr qc;
    bool needReconnect = true;
    std::string log_header = "[OP:" + std::string(nodeIp) + "]: ";
    while (!shouldExit)
    {
        try {
            if (needReconnect)
            {
                nPeer.fetch_add(1);
                needReconnect = false;
                qc = make_qc(nodeIp, OPERATOR_PORT);
                printf("%sConnected OPERATOR node %s\n", log_header.c_str(), nodeIp);
            }

            bool haveCustomMiningData = fetchCustomMiningData(qc, log_header.c_str());
            if (!haveCustomMiningData)
            {
                SLEEP(1000);
            }
            else
            {
                SLEEP(50000);
            }
        }
        catch (std::logic_error &ex) {
            printf("%s\n", ex.what());
            fflush(stdout);
            needReconnect = true;
            nPeer.fetch_add(-1);
            SLEEP(1000);
        }
        catch (...)
        {
            printf("Unknown exception caught!\n");
            fflush(stdout);
            needReconnect = true;
            nPeer.fetch_add(-1);
            SLEEP(1000);
        }
    }
}

std::vector<std::string> split(const std::string& s, char delimiter) {
    std::vector<std::string> result;
    std::stringstream ss(s);
    std::string item;
    while (getline(ss, item, delimiter)) {
        result.push_back(item);
    }
    return result;
}

void printHelp()
{
    printf("./oc_verifier --seed [OPERATOR SEED] --nodeip [OPERATOR node ip] --peers [nodeip0],[nodeip1], ... ,[nodeipN]\n");
    printf("              [--track] to enable computor index tracking\n");
}

int run(int argc, char *argv[]) {
    if (argc == 1) {
        printHelp();
        return 0;
    }

    std::string seed, operatorIp;
    std::vector<std::string> peers;
    bool enableTracking = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];

        if (arg == "--seed")
        {
            seed = argv[++i];
        }
        else if(arg == "--nodeip")
        {
            operatorIp = argv[++i];
        }
        else if (arg == "--peers")
        {
            std::string peerList = argv[++i];
            peers = split(peerList, ',');
        }
        else if (arg == "--track")
        {
            enableTracking = true;
        }
        else if (arg == "--help")
        {
            printHelp();
            return 0;
        }
        else
        {
            printHelp();
            return 1;
        }
    }

    // Print parsed values
    if (!seed.empty())
    {
        memcpy(operatorSeed, seed.c_str(), 56);
        std::cout << "Seed: " << operatorSeed << std::endl;
        getKey();
    }
    std::cout << "OperatorID: " << operatorPublicIdentity << "\n";
    std::cout << "Node IP: " << operatorIp << "\n";
    std::cout << "Peers: ";
    for (const auto& peer : peers)
    {
        std::cout << peer << ", ";
    }
    std::cout << std::endl;

    // Prompt for computor indices to track if tracking is enabled
    if (enableTracking)
    {
        promptForTrackedIndices();
    }

    auto now = std::chrono::system_clock::now();
    auto duration = now.time_since_epoch();
    auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(duration).count();
    lastTaskTimeStamp = milliseconds;

    // Generate computor groups
    for (int i = 0; i < NUMBER_OF_TASK_PARTITIONS; i++)
    {
        gTaskPartition[i].firstComputorIdx = i * NUMBER_OF_COMPUTORS / 4;
        gTaskPartition[i].lastComputorIdx = gTaskPartition[i].firstComputorIdx + NUMBER_OF_COMPUTORS / 4 - 1;
        gTaskPartition[i].domainSize =  (uint32_t)((1ULL << 32) / ((uint64_t)gTaskPartition[i].lastComputorIdx  - gTaskPartition[i].firstComputorIdx + 1));
    }

    // Print the domain size
    std::cout << "Task/Share partiion: \n";
    for (int i = 0; i < NUMBER_OF_TASK_PARTITIONS; i++)
    {
        std::cout << " - [" << i << "] first: " << gTaskPartition[i].firstComputorIdx;
        std::cout << ", last:" << gTaskPartition[i].lastComputorIdx;
        std::cout << ", domainSize:" << gTaskPartition[i].domainSize;
        std::cout << std::endl;
    }

    getPublicKeyFromIdentity(DISPATCHER, dispatcherPubkey);
    std::vector<std::thread> thr;

    // Fetch task from peers
    if (peers.size() > 0)
    {
        for (size_t i = 0; i < peers.size(); i++)
        {
            thr.push_back(std::thread(listenerThread, peers[i].c_str()));
        }
    }

    // Fetch tasks from node ip
    initRandomX();
    std::shared_ptr<std::thread> operator_thread;
    if (!seed.empty() && !operatorIp.empty())
    {
        operator_thread = std::make_shared<std::thread>(operatorFetcherThread, operatorIp.c_str());
    }

    std::thread verify_thr[XMR_VERIFY_THREAD];
    for (int i = 0; i < XMR_VERIFY_THREAD; i++)
    {
        verify_thr[i] = std::thread(verifyThread, i);
    }

    std::shared_ptr<std::thread> submit_thr;
    if (!seed.empty())
    {
        submit_thr = std::make_shared<std::thread>(submitVerifiedSolution, operatorIp.c_str());
    }

    SLEEP(3000);
    while (!shouldExit)
    {
        if (enableTracking && !gTrackedIndices.empty())
        {
            printf("Active peer: %d | Valid: %lu | Invalid: %lu | Stale: %lu | Submit: %lu\n", 
                   nPeer.load(), gValid.load(), gInValid.load(), gStale.load(), gSubmittedSols.load());
            printTrackedStats();
        }
        else
        {
            printf("Active peer: %d | Valid: %lu | Invalid: %lu | Stale: %lu | Submit: %lu\n", 
                   nPeer.load(), gValid.load(), gInValid.load(), gStale.load(), gSubmittedSols.load());
        }
        SLEEP(10000);
    }
    cleanRandomX();

    return 0;
}

int main(int argc, char *argv[]) {

#ifndef _MSC_VER
    // Ignore SIGPIPE globally
    std::signal(SIGPIPE, SIG_IGN);
#endif

    gStale = 0;
    gInValid = 0;
    gValid = 0;
    nPeer = 0;
    try {
        return run(argc, argv);
    }
    catch (std::exception &ex) {
        printf("%s\n", ex.what());
        return -1;
    }
}
