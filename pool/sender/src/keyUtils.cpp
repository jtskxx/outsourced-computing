#include <cstdint>
#include <vector>
#include "keyUtils.h"
#include "K12AndKeyUtil.h"

bool getSubseedFromSeed(const unsigned char* seed, unsigned char* subseed)
{
    unsigned char seedBytes[55];
    for (int i = 0; i < 55; i++)
    {
        if (seed[i] < 'a' || seed[i] > 'z')
        {
            return false;
        }
        seedBytes[i] = seed[i] - 'a';
    }
    KangarooTwelve(seedBytes, sizeof(seedBytes), subseed, 32);

    return true;
}
void getPrivateKeyFromSubSeed(const unsigned char* seed, unsigned char* privateKey)
{
    KangarooTwelve(seed, 32, privateKey, 32);
}
void getPublicKeyFromPrivateKey(const unsigned char* privateKey, unsigned char* publicKey)
{
    point_t P;
    ecc_mul_fixed((unsigned long long*)privateKey, P); // Compute public key
    encode(P, publicKey);
}

void getIdentityFromPublicKey(const unsigned char* pubkey, char* dstIdentity, bool isLowerCase)
{
    unsigned char publicKey[32];
    memcpy(publicKey, pubkey, 32);
    uint16_t identity[61] = { 0 };
    for (int i = 0; i < 4; i++)
    {
        unsigned long long publicKeyFragment = *((unsigned long long*) & publicKey[i << 3]);
        for (int j = 0; j < 14; j++)
        {
            identity[i * 14 + j] = publicKeyFragment % 26 + (isLowerCase ? L'a' : L'A');
            publicKeyFragment /= 26;
        }
    }
    unsigned int identityBytesChecksum;
    KangarooTwelve(publicKey, 32, (unsigned char*)&identityBytesChecksum, 3);
    identityBytesChecksum &= 0x3FFFF;
    for (int i = 0; i < 4; i++)
    {
        identity[56 + i] = identityBytesChecksum % 26 + (isLowerCase ? L'a' : L'A');
        identityBytesChecksum /= 26;
    }
    identity[60] = 0;
    for (int i = 0; i < 60; i++) dstIdentity[i] = identity[i];
}
void getTxHashFromDigest(const unsigned char* digest, char* txHash)
{
    bool isLowerCase = true;
    getIdentityFromPublicKey(digest, txHash, isLowerCase);
}

void getPublicKeyFromIdentity(const char* identity, unsigned char* publicKey)
{
    unsigned char publicKeyBuffer[32];
    for (int i = 0; i < 4; i++)
    {
        *((unsigned long long*) & publicKeyBuffer[i << 3]) = 0;
        for (int j = 14; j-- > 0; )
        {
            if (identity[i * 14 + j] < 'A' || identity[i * 14 + j] > 'Z')
            {
                return;
            }

            *((unsigned long long*) & publicKeyBuffer[i << 3]) = *((unsigned long long*) & publicKeyBuffer[i << 3]) * 26 + (identity[i * 14 + j] - 'A');
        }
    }
    memcpy(publicKey, publicKeyBuffer, 32);
}

bool checkSumIdentity(char* identity)
{
    unsigned char publicKeyBuffer[32];
    for (int i = 0; i < 4; i++)
    {
        *((unsigned long long*) & publicKeyBuffer[i << 3]) = 0;
        for (int j = 14; j-- > 0; )
        {
            if (identity[i * 14 + j] < 'A' || identity[i * 14 + j] > 'Z')
            {
                return false;
            }

            *((unsigned long long*) & publicKeyBuffer[i << 3]) = *((unsigned long long*) & publicKeyBuffer[i << 3]) * 26 + (identity[i * 14 + j] - 'A');
        }
    }
    unsigned int identityBytesChecksum;
    KangarooTwelve(publicKeyBuffer, 32, (unsigned char*)&identityBytesChecksum, 3);
    identityBytesChecksum &= 0x3FFFF;
    for (int i = 0; i < 4; i++)
    {
        if (identityBytesChecksum % 26 + 'A' != identity[56 + i])
        {
            return false;
        }
        identityBytesChecksum /= 26;
    }
    return true;
}