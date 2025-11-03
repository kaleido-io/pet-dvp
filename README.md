# Demonstrations of DvP patterns b/w Privacy Tokens

This project demonstrates a number of DvP patterns for atomic settlement between transfers of privacy preserving tokens.

## Different Designs of Pivacy Token implementations

Two major designs of privacy preserving tokens are covered:

- Fully Homomorphic Encryption (FHE) based. This category of tokens tend to use an account model for managing the onchain states, where a map of account addresses and encrypted balances is maintained by the token contract. In particular, the Confidential ERC20 tokens implemented in https://github.com/OpenZeppelin/openzeppelin-confidential-contracts/tree/master based on Zama was used in the example.
- Commitment based. This category of tokens tend to use a UTXO model for the onchain states, where each UTXO is a hash-based commitment to the secrets of the token (owner, value). Exmaples of this design pattern include Zcash, Railgun, and LFDT Paladin's Noto and Zeto tokens.

## DvP Pattern 1: Confidential ERC20 with deposit in escrow vs. Zeto with locking

The flows for the secure exchange of tokens between two parties, one using a vanilla Confidential ERC20 token, another using a UTXO based privacy token that supports locking.

### Propose -> Accept -> Approve -> Execute

```mermaid
sequenceDiagram
  actor A as Alice (seller)
  participant Aw as Alice wallet
  participant A1 as Asset-1 contract<br>(UTXO)
  participant E as Escrow contract
  participant A2 as Asset-2 contract<br>(FHE)
  participant Bw as Bob wallet
  actor B as Bob (buyer)
  par Alice (seller) proposes trade
  rect rgb(200, 150, 255)
    A->>Aw: deposit Asset-1 token A1
    Aw->>A1: lock asset-1 token(s) to Escrow
    A1->>A1: set Escrow as delegate for A1
    A1-->>Aw: lock event (lockId-1, UTXO hash for A1)
    A1-->>Bw: lock event (lockId-1, UTXO hash for A1)
  end
  end
  par Alice sends partial secret for A1 to Bob to verify the trade proposal
  rect rgb(200, 150, 255)
    A->>B: salt for A1
    B->>B: verify A1 == H(Bob pub key, expected trade value, salt)?
  end
  end
  par Bob (buyer) accepts the trade proposal
  rect rgb(191, 223, 255)
    B->>Bw: approves proposal
    Bw->>A2: transfers Asset-2 tokens amount=A2 to Escrow<br>creates lockId<->ciphertext map entry
    A2->>A2: moves amount=A2 to Escrow account
    Bw->>A2: approves Alice to see the encrypted value just transferred
    A2->>A2: calls allow(ciphertext, Alice)
  end
  end
  par Alice (seller) verifies the trade response
  rect rgb(200, 150, 255)
    A->>A2: queries the ciphertext (transfer amount), decrypts to verify expected value
  end
  end
  par Alice (seller) accepts the trade response & completes the trade proposal
  rect rgb(200, 150, 255)
    A->>E: setup atomic trade: deliveryLockId = lockId-1
    B->>E: complete atomic trade: paymentId = ciphertextHandle
  end
  end
  par trade execution approvals
    rect rgb(200, 150, 255)
    A->>Aw: approves trade
    Aw->>A1: delegate lockId-1 to the escrow contract
    end
    rect rgb(191, 223, 255)
    B->>Bw: approves trade
    Bw->>A2: calls allow(ciphertext, Escrow)
    end
  end
  par trade execution
    A->>E: execute trade
    E->>A1: unlocks lockId-1
    A1->>A1: consumes locked asset and creates new asset for Bob
    A1-->>Bw: new asset UTXO for Bob
    A2->>A2: transfers ciphertext amount to Alice
    A2-->>Aw: transfer(Alice, ciphertext)
  end
```

### Seller Proposes -> Buyer Rejects

```mermaid
sequenceDiagram
  actor A as Alice (seller)
  participant Aw as Alice wallet
  participant A1 as Asset-1 contract<br>(UTXO)
  participant Escrow contract
  participant A2 as Asset-2 contract<br>(FHE)
  participant Bw as Bob wallet
  actor B as Bob (buyer)
  par Alice (seller) proposes trade
    A->>Aw: deposit Asset-1 token A1
    Aw->>A1: lock asset-1 token(s) to Escrow
    A1->>A1: set Escrow as delegate for A1
    A1-->>Aw: lock event (lockId, UTXO hash for A1)
    A1-->>Bw: lock event (lockId, UTXO hash for A1)
  end
  par Alice sends partial secret for A1 to Bob to verify the trade proposal
    A->>B: salt for A1
    B->>B: verify A1 == H(Bob pub key, expected trade value, salt)?
  end
  par Bob (buyer) rejects the trade proposal
    B->>Bw: disapprove proposal (do nothing)
    A->>Aw: rescind offer
    Aw->>A1: unlock token(s) A1 to recover the value
  end
```

### Seller proposes -> Buyer accepts & responds -> Seller rejects response

```mermaid
sequenceDiagram
  actor A as Alice (seller)
  participant Aw as Alice wallet
  participant A1 as Asset-1 contract<br>(UTXO)
  participant Escrow contract
  participant A2 as Asset-2 contract<br>(FHE)
  participant Bw as Bob wallet
  actor B as Bob (buyer)
  par Alice (seller) proposes trade
    A->>Aw: deposit Asset-1 token A1
    Aw->>A1: lock asset-1 token(s) to Escrow
    A1->>A1: set Escrow as delegate for A1
    A1-->>Aw: lock event (lockId, UTXO hash for A1)
    A1-->>Bw: lock event (lockId, UTXO hash for A1)
  end
  par Alice sends partial secret for A1 to Bob to verify the trade proposal
    A->>B: salt for A1
    B->>B: verify A1 == H(Bob pub key, expected trade value, salt)?
  end
  par Bob (buyer) accepts the trade proposal
    B->>Bw: approves proposal
    Bw->>A2: transfers Asset-2 tokens amount=A2 to Escrow<br>creates lockId<->ciphertext map entry
    A2->>A2: moves amount=A2 to Escrow account
    Bw->>A2: approves Alice to see the encrypted value just transferred
    A2->>A2: calls allow(ciphertext, Alice)
  end
  par Alice verifies the trade response
    A->>A2: queries the ciphertext (transfer amount), decrypts to verify expected value
  end
  par Alice (seller) rejects the trade response
    A->>Aw: rescind the offer
    Aw->>A1: unlock token(s) A1 to recover the value
  end
```

### Propose -> Accept -> Seller approves & Buyer disapproves

[to be continued]

## DvP Pattern 2: Confidential ERC20 with locking vs. Zeto with locking

The flows for the secure exchange of tokens between two parties, one using a Confidential ERC20 token enhanced with locking, another using a UTXO based privacy token that supports locking.

[to be continued]
