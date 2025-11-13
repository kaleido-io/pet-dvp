// Copyright © 2024 Kaleido, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { ethers, fhevm, network } from "hardhat";
import { FhevmType } from '@fhevm/hardhat-plugin';
import { ContractTransactionReceipt, ZeroHash } from "ethers";
import { expect } from "chai";
import { Merkletree, InMemoryDB, str2Bytes } from "@iden3/js-merkletree";
import { loadCircuit, Poseidon } from "zeto-js";

process.env.SKIP_ANON_TESTS = "true";
process.env.SKIP_ANON_NULLIFIER_TESTS = "true";
import { prepareProof, encodeToBytes } from "zeto-solidity/test/zeto_anon_nullifier";
import { prepareProof as prepareProofLocked, encodeToBytes as encodeToBytesLocked } from "zeto-solidity/test/zeto_anon";
import {
  UTXO,
  User,
  newUser,
  newUTXO,
  newNullifier,
  doMint,
  ZERO_UTXO,
  parseUTXOEvents,
} from "zeto-solidity/test/lib/utils";
import { deployZeto } from "zeto-solidity/test/lib/deploy";
import { loadProvingKeys } from "zeto-solidity/test/utils";
import { Atom } from "../typechain-types";

describe("DvP flows between FHE based ERC20 tokens and Zeto based fungible tokens", function () {
  // users interacting with each other in the DvP transactions
  let Deployer: User; // the minter of the FHE ERC20 tokens and Zeto tokens
  let Alice: User; // the user who holds the Zeto tokens
  let Bob: User; // the user who holds the FHE ERC20 tokens

  // instances of the contracts
  let zkPayment: any;
  let fheERC20: any;

  // Alice's payment UTXOs to be minted and transferred
  let payment1: UTXO;
  let payment2: UTXO;

  // other variables
  let smtAlice: Merkletree;

  let circuit: any;
  let circuitForLocked: any;
  let provingKey: string;
  let provingKeyForLocked: string;

  before(async function () {
    if (network.name !== "hardhat") {
      // accommodate for longer block times on public networks
      this.timeout(120000);
    }
    let [deployer, a, b] = await ethers.getSigners();
    Deployer = await newUser(deployer);
    Alice = await newUser(a);
    Bob = await newUser(b);

    const storage1 = new InMemoryDB(str2Bytes(""));
    smtAlice = new Merkletree(storage1, true, 64);

    // deploy the Zeto contract for the Zeto tokens
    ({ zeto: zkPayment } = await deployZeto("Zeto_AnonNullifier"));
    console.log(`ZK Payment contract deployed at ${zkPayment.target}`);

    // load the circuits for the Zeto tokens
    circuit = await loadCircuit("anon_nullifier_transfer");
    ({ provingKeyFile: provingKey } = loadProvingKeys(
      "anon_nullifier_transfer",
    ));
    circuitForLocked = await loadCircuit("anon");
    ({ provingKeyFile: provingKeyForLocked } = loadProvingKeys(
      "anon",
    ));

    // deploy the FHE ERC20 contract for the FHE ERC20 tokens
    const factory = await ethers.getContractFactory("FheERC20");
    fheERC20 = await factory.connect(Deployer.signer).deploy();
    console.log(`FHE ERC20 contract deployed at ${fheERC20.target}`);
  });

  it("mint to Alice some payment tokens in Zeto", async function () {
    payment1 = newUTXO(100, Alice);
    payment2 = newUTXO(20, Alice);
    const result = await doMint(zkPayment, Deployer.signer, [payment1, payment2]);

    // simulate Alice listening to minting events and updating her local merkle tree
    for (const log of result.logs) {
      const event = zkPayment.interface.parseLog(log as any);
      expect(event.args.outputs.length).to.equal(2);
      const utxos = event.args.outputs;
      await smtAlice.add(utxos[0], utxos[0]);
      await smtAlice.add(utxos[1], utxos[1]);
    }

    let root = await smtAlice.root();
    let onchainRoot = await zkPayment.getRoot();
    expect(root.string()).to.equal(onchainRoot.toString());
  });

  it("mint to Bob some FHE ERC20 tokens", async function () {
    const encryptedInput = await fhevm
      .createEncryptedInput(fheERC20.target, Deployer.ethAddress)
      .add64(1000)
      .encrypt();

    const tx = await fheERC20.connect(Deployer.signer).mint(Bob.ethAddress, encryptedInput.handles[0], encryptedInput.inputProof);
    await tx.wait();

    // check the balance of Bob in the FHE ERC20 contract
    const balance = await fheERC20.confidentialBalanceOf(Bob.signer);
    await expect(
      fhevm.userDecryptEuint(FhevmType.euint64, balance, fheERC20.target, Bob.signer),
    ).to.eventually.equal(1000);
  });

  describe("Trade flow between Alice (using Zeto tokens) and Bob (using FHE ERC20 tokens)", function () {
    let lockedUtxo: UTXO;
    let utxoLockEvent: any;
    let salt: bigint;

    let atomInstance: any;

    let encodedCallDataBob: string;

    it("Alice and Bob agrees on an Atom contract instance to use for the trade", async function () {
      const atomFactory = await ethers.getContractFactory("Atom");
      atomInstance = await atomFactory.connect(Alice.signer).deploy();
      console.log("Atom contract instance deployed at", atomInstance.target);
    });

    describe("Trade proposal setup (by Alice) and response (by Bob)", function () {
      it("Alice locks a UTXO to initiate a trade with Bob", async function () {
        // Alice consumes a Zeto token and locks it
        const nullifier1 = newNullifier(payment1, Alice);
        // The locked UTXO is owned by Alice, who is responsible for generating the proof
        // and giving it to the Atom contract as the delegate.
        lockedUtxo = newUTXO(payment1.value!, Alice);
        const root = await smtAlice.root();
        const proof1 = await smtAlice.generateCircomVerifierProof(
          payment1.hash,
          root,
        );
        const proof2 = await smtAlice.generateCircomVerifierProof(0n, root);
        const merkleProofs = [
          proof1.siblings.map((s) => s.bigInt()),
          proof2.siblings.map((s) => s.bigInt()),
        ];
        const encodedProof = await prepareProof(
          circuit,
          provingKey,
          Alice,
          [payment1, ZERO_UTXO],
          [nullifier1, ZERO_UTXO],
          [lockedUtxo, ZERO_UTXO],
          root.bigInt(),
          merkleProofs,
          [Alice, Alice],
        );

        const lockParameters = {
          inputs: [nullifier1.hash],
          outputs: [],
          lockedOutputs: [lockedUtxo.hash],
        };
        const tx = await zkPayment.connect(Alice.signer).prepareLock(
          lockParameters,
          Alice.ethAddress, // the delegate is Alice before she commits to the trade
          encodeToBytes(root.bigInt(), encodedProof), // encode the root and proof together
          "0x",
        );
        const result: ContractTransactionReceipt | null = await tx.wait();

        // Note that the locked UTXO should NOT be added to the local SMT for UTXOs because it's tracked in a separate SMT onchain
        // we add it to the local SMT for locked UTXOs
        const events = parseUTXOEvents(zkPayment, result!);
        utxoLockEvent = events[0];
        // Alice will share this with Bob in secure p2p communication channels
        salt = lockedUtxo.salt! as bigint;
      });

      it("Bob uses the Zeto event and the salt received from Alice to verify the trade proposal", async function () {
        // Bob knows the expected value of the locked UTXO, based his prior negotiation with Alice
        const expectedValue = BigInt(100);
        // assume Bob has received the salt from Alice in secure p2p communication channels
        const expectedHashForLockedUtxo = getUTXOHash(expectedValue, salt, Alice);
        expect(utxoLockEvent.lockedOutputs[0]).to.equal(expectedHashForLockedUtxo);
      });

      it("Bob transfers 50 of his FHE ERC20 tokens to the Atom contract & approves Alice to access the encrypted amount", async function () {
        // Bob first transfers 50 of his FHE ERC20 tokens to the Atom contract
        const encryptedInput = await fhevm
          .createEncryptedInput(fheERC20.target, Bob.ethAddress)
          .add64(50)
          .encrypt();

        const tx1 = await fheERC20.connect(Bob.signer)["confidentialTransfer(address,bytes32,bytes)"](atomInstance.target, encryptedInput.handles[0], encryptedInput.inputProof);
        await tx1.wait();

        // Bob then approves Alice to access the encrypted amount, in order for Alice to 
        // verify the trade proposal response, by checking the balance of the Atom contract in the FHE ERC20 contract
        const tx2 = await atomInstance.connect(Bob.signer).allowBalanceCheck(fheERC20, Alice.ethAddress);
        await tx2.wait();
      });

      it("Alice verifies the trade proposal response from Bob, by checking the balance of the Atom contract in the FHE ERC20 contract", async function () {
        // Alice verifies the trade proposal
        const encryptedAmount = await fheERC20.confidentialBalanceOf(atomInstance.target);
        const decryptedAmount = await fhevm.userDecryptEuint(FhevmType.euint64, encryptedAmount, fheERC20.target, Alice.signer);
        expect(decryptedAmount).to.equal(50);
      });
    });

    describe("Trade approvals", function () {
      let lockId: string;
      it("Alice approves the trade by committing to the lock, and designating the Atom contract as the delegate", async function () {
        // Alice prepares an output UTXO for Bob as the output of the trade
        const paymentForBob = newUTXO(75, Bob);
        const changeForAlice = newUTXO(25, Alice);
        const encodedProof = await prepareProofLocked(
          circuitForLocked,
          provingKeyForLocked,
          Alice,
          [lockedUtxo, ZERO_UTXO],
          [paymentForBob, changeForAlice],
          [Bob, Alice],
          atomInstance.target, // the Atom contract will be the delegate
        );
        lockId = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const settleOperation = {
          outputStates: {
            outputs: [paymentForBob.hash, changeForAlice.hash],
            lockedOutputs: [],
          },
          proof: encodeToBytesLocked(encodedProof),
          data: "0x",
        }
        const refundOperation = {
          outputStates: {
            outputs: [],
            lockedOutputs: [],
          },
          proof: "0x",
          data: "0x",
        }
        const commitLockTx = await zkPayment.connect(Alice.signer).commitLock(lockId, [lockedUtxo.hash], atomInstance.target, settleOperation, refundOperation, "0x");
        await commitLockTx.wait();

        // now Alice can delegate the lock to the Atom contract
        const delegateLockTx = await zkPayment.connect(Alice.signer).delegateLock(lockId, atomInstance.target, "0x");
        await delegateLockTx.wait();
      });

      it("Bob decodes the LockCommit event, decodes the lock operation parameters, and verifies the output UTXOs", async function () {
        // Bob decodes the LockCommit event...
      });

      it("Bob encodes the call to transfer from the Atom contract to Alice", async function () {
        // Bob then encodes the call to transfer from the Atom contract to Alice
        const encryptedInput2 = await fhevm
          .createEncryptedInput(fheERC20.target, atomInstance.target)
          .add64(50)
          .encrypt();
        encodedCallDataBob = fheERC20.interface.encodeFunctionData(
          "confidentialTransfer(address,bytes32,bytes)",
          [Alice.ethAddress, encryptedInput2.handles[0], encryptedInput2.inputProof]
        );
      });

      it("Alice and Bob each produce the encoded call data and initialize the Atom contract", async function () {
        const operations = [
          {
            contractAddress: zkPayment.target,
            lockId: lockId,
            callData: "0x",
          },
          {
            contractAddress: fheERC20.target,
            lockId: "0x0000000000000000000000000000000000000000000000000000000000000000",
            callData: encodedCallDataBob,
          }
        ]
        const tx = await atomInstance.connect(Alice.signer).initialize(operations);
        await tx.wait();
      });
    });

    describe("Trade execution", function () {
      it("One of Alice or Bob executes the Atom contract to complete the trade", async function () {
        // check the balance of Alice
        const balanceAliceBefore = await fheERC20.confidentialBalanceOf(Alice.signer);
        expect(balanceAliceBefore).to.equal(ZeroHash);

        // check the balance of Bob
        const balanceBobBefore = await fheERC20.confidentialBalanceOf(Bob.signer);
        await expect(
          fhevm.userDecryptEuint(FhevmType.euint64, balanceBobBefore, fheERC20.target, Bob.signer),
        ).to.eventually.equal(950);

        if (Math.random() < 0.5) {
          const tx = await atomInstance.connect(Alice.signer).settle();
          await tx.wait();
        } else {
          const tx = await atomInstance.connect(Bob.signer).settle();
          await tx.wait();
        }

        // check the balance of Alice
        const balanceAliceAfter = await fheERC20.confidentialBalanceOf(Alice.signer);
        await expect(
          fhevm.userDecryptEuint(FhevmType.euint64, balanceAliceAfter, fheERC20.target, Alice.signer),
        ).to.eventually.equal(50);

        // check the balance of Bob
        const balanceBobAfter = await fheERC20.confidentialBalanceOf(Bob.signer);
        await expect(
          fhevm.userDecryptEuint(FhevmType.euint64, balanceBobAfter, fheERC20.target, Bob.signer),
        ).to.eventually.equal(950);
      });
    });
  });
}).timeout(600000);

function getUTXOHash(value: bigint, salt: bigint, owner: User): bigint {
  return Poseidon.poseidon4([value, salt, owner.babyJubPublicKey[0], owner.babyJubPublicKey[1]]) as bigint;
}