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
import { randomBytes } from "crypto";

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
  parseUTXOEvents
} from "zeto-solidity/test/lib/utils";
import { deployZeto } from "zeto-solidity/test/lib/deploy";
import { loadProvingKeys } from "zeto-solidity/test/utils";

describe("DvP flows between FHE based ERC20 tokens and Zeto based fungible tokens", function () {
  // users interacting with each other in the DvP transactions
  let Deployer: User; // the minter of the FHE ERC20 tokens and Zeto tokens
  let Alice: User; // the user who holds the Zeto tokens
  let Bob: User; // the user who holds the FHE ERC20 tokens

  // instances of the contracts
  let zkPayment: any;
  let fheERC20: any;
  let atomFactory: any;

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
    const factory = await ethers.getContractFactory("FheERC20Lockable");
    fheERC20 = await factory.connect(Deployer.signer).deploy();
    console.log(`FHE ERC20 Lockable contract deployed at ${fheERC20.target}`);

    const afFactory = await ethers.getContractFactory("AtomFactory");
    atomFactory = await afFactory.connect(Alice.signer).deploy();
    console.log("AtomFactory contract instance deployed at", atomFactory.target);
  });

  it("mint to Alice some payment tokens in Zeto", async function () {
    payment1 = newUTXO(100, Alice);
    payment2 = newUTXO(200, Alice);
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

  describe("Successful end to end trade flow between Alice (using Zeto tokens) and Bob (using FHE ERC20 tokens)", function () {
    let lockedUtxo: UTXO;
    let lockIdAlice: string;
    let lockIdBob: string;
    let lockEventBob: any;

    let atomInstance: any;

    describe("Trade proposal setup by Alice and Bob", function () {
      let saltForProposedPaymentForBob: bigint;
      let lockCreateEvent: any;

      it("Alice and Bob agree on an Atom contract instance to use for the trade", async function () {
        // generate random lockId for Alice's lock
        lockIdAlice = "0x" + randomBytes(32).toString("hex");
        // generate random lockId for Bob's lock
        lockIdBob = "0x" + randomBytes(32).toString("hex");

        const operationAlice = {
          lockableContract: zkPayment,
          approver: Alice.ethAddress,
          lockId: lockIdAlice,
        };
        const operationBob = {
          lockableContract: fheERC20,
          approver: Bob.ethAddress,
          lockId: lockIdBob,
        };
        const tx = await atomFactory.connect(Alice.signer).create([operationAlice, operationBob]);
        const result: ContractTransactionReceipt | null = await tx.wait();
        const atomDeployedEvent = parseLockEvents(atomFactory, result!)[0];
        const instance = atomDeployedEvent?.atomInstance;
        atomInstance = await ethers.getContractAt("Atom", instance);
        console.log("Atom contract instance deployed at", atomInstance.target);
      });

      it("Alice uses the lock ID in the Atom contract to lock a UTXO for the trade with Bob", async function () {
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
        const paymentForBob = newUTXO(75, Bob);
        saltForProposedPaymentForBob = paymentForBob.salt! as bigint;
        const changeForAlice = newUTXO(25, Alice);
        const encodedProofForSettle = await prepareProofLocked(
          circuitForLocked,
          provingKeyForLocked,
          Alice,
          [lockedUtxo, ZERO_UTXO],
          [paymentForBob, changeForAlice],
          [Bob, Alice],
          atomInstance.target, // the Atom contract will be the delegate
        );
        const settleOperation = {
          outputStates: {
            outputs: [paymentForBob.hash, changeForAlice.hash],
            lockedOutputs: [],
          },
          proof: encodeToBytesLocked(encodedProofForSettle),
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
        const tx = await zkPayment.connect(Alice.signer).createLock(
          lockIdAlice,
          lockParameters,
          encodeToBytes(root.bigInt(), encodedProof), // encode the root and proof together
          atomInstance.target,
          settleOperation,
          refundOperation,
          "0x",
        );
        const result: ContractTransactionReceipt | null = await tx.wait();
        lockCreateEvent = parseLockEvents(zkPayment, result!)[0];
      });

      it("Bob decodes the LockCommit event, decodes the lock operation parameters, and verifies the output UTXOs", async function () {
        // check that the lockId in the event is the same as the lockId used in the operation for Alice's lock
        expect(lockCreateEvent.lockId).to.equal(lockIdAlice);
        // Bob decodes the LockCommit event...
        const lockData = lockCreateEvent.lockData;
        // check that the lock will produce the output UTXO to be owned by Bob upon settlement
        const expectedHashForProposedPaymentForBob = getUTXOHash(BigInt(75), saltForProposedPaymentForBob, Bob);
        expect(lockData.settle.outputStates.outputs[0]).to.equal(expectedHashForProposedPaymentForBob);
        // check that the lock is delegated to the Atom contract
        expect(lockData.delegate).to.equal(atomInstance.target);
      });

      it("Bob agrees with the trade proposal by Alice, and locks 50 of his FHE ERC20 tokens", async function () {
        // Bob locks 50 of his FHE ERC20 tokens, designating the Atom contract as the delegate
        const encryptedInput = await fhevm
          .createEncryptedInput(fheERC20.target, Bob.ethAddress)
          .add64(50)
          .encrypt();

        const tx1 = await fheERC20.connect(Bob.signer).createLock(lockIdBob, Alice.ethAddress, atomInstance.target, encryptedInput.handles[0], encryptedInput.inputProof, "0x");
        const result: ContractTransactionReceipt | null = await tx1.wait();

        lockEventBob = parseLockEvents(fheERC20, result!)[0];
        expect(lockEventBob.lockId).to.equal(lockIdBob);
        expect(lockEventBob.delegate).to.equal(atomInstance.target);
      });

      it("Alice verifies the trade proposal response from Bob, by checking the encrypted amount in the LockCreated event", async function () {
        // Alice verifies the trade proposal
        const lockedAmount = lockEventBob.amount;
        const decryptedLockedAmount = await fhevm.userDecryptEuint(FhevmType.euint64, lockedAmount, fheERC20.target, Alice.signer);
        expect(decryptedLockedAmount).to.equal(50);
        expect(lockEventBob.owner).to.equal(Bob.ethAddress);
        expect(lockEventBob.receiver).to.equal(Alice.ethAddress);
      });
    });

    describe("Trade approvals", function () {
      it("Bob approves the trade by approving the lock operation", async function () {
        const tx = await atomInstance.connect(Bob.signer).approveOperation(1);
        await tx.wait();
      });
      it("Alice approves the trade by approving the lock operation", async function () {
        const tx = await atomInstance.connect(Alice.signer).approveOperation(0);
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

  describe("Failed trade flow - counterparty fails to fulfill obligations during setup phase", function () {
    let lockedUtxo: UTXO;
    let lockIdAlice: string;
    let lockIdBob: string;
    let refundForAlice: UTXO;

    let atomInstance: any;

    before(async function () {
      const afFactory = await ethers.getContractFactory("AtomFactory");
      atomFactory = await afFactory.connect(Alice.signer).deploy();
      console.log("AtomFactory contract instance deployed at", atomFactory.target);
    });

    describe("Trade proposal setup by Alice", function () {
      let cancelTxResult: any;

      it("Alice and Bob agree on an Atom contract instance to use for the trade", async function () {
        // generate random lockId for Alice's lock
        lockIdAlice = "0x" + randomBytes(32).toString("hex");
        // generate random lockId for Bob's lock
        lockIdBob = "0x" + randomBytes(32).toString("hex");

        const operationAlice = {
          lockableContract: zkPayment,
          approver: Alice.ethAddress,
          lockId: lockIdAlice,
        };
        const operationBob = {
          lockableContract: fheERC20,
          approver: Bob.ethAddress,
          lockId: lockIdBob,
        };
        const tx = await atomFactory.connect(Alice.signer).create([operationAlice, operationBob]);
        const result: ContractTransactionReceipt | null = await tx.wait();
        const atomDeployedEvent = parseLockEvents(atomFactory, result!)[0];
        const instance = atomDeployedEvent?.atomInstance;
        atomInstance = await ethers.getContractAt("Atom", instance);
        console.log("Atom contract instance deployed at", atomInstance.target);
      });

      it("Alice uses the lock ID in the Atom contract to lock a UTXO for the trade with Bob", async function () {
        // Alice consumes a Zeto token and locks it
        const nullifier1 = newNullifier(payment2, Alice);
        // The locked UTXO is owned by Alice, who is responsible for generating the proof
        // and giving it to the Atom contract as the delegate.
        lockedUtxo = newUTXO(payment2.value!, Alice);
        const root = await smtAlice.root();
        const proof1 = await smtAlice.generateCircomVerifierProof(
          payment2.hash,
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
          [payment2, ZERO_UTXO],
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
        // prepare the settle operation:
        // - output UTXO of 75 for Bob
        // - output UTXO of 125 for Alice
        const paymentForBob = newUTXO(75, Bob);
        const changeForAlice = newUTXO(125, Alice);
        const encodedProofForSettle = await prepareProofLocked(
          circuitForLocked,
          provingKeyForLocked,
          Alice,
          [lockedUtxo, ZERO_UTXO],
          [paymentForBob, changeForAlice],
          [Bob, Alice],
          atomInstance.target, // the Atom contract will be the delegate
        );
        const settleOperation = {
          outputStates: {
            outputs: [paymentForBob.hash, changeForAlice.hash],
            lockedOutputs: [],
          },
          proof: encodeToBytesLocked(encodedProofForSettle),
          data: "0x",
        }
        // prepare the refund operation:
        // - refund the locked UTXO to Alice
        // - no locked UTXOs
        refundForAlice = newUTXO(lockedUtxo.value!, Alice);
        const encodedProofForRollback = await prepareProofLocked(
          circuitForLocked,
          provingKeyForLocked,
          Alice,
          [lockedUtxo, ZERO_UTXO],
          [refundForAlice, ZERO_UTXO],
          [Alice, Alice],
          atomInstance.target, // the Atom contract will be the delegate
        );
        const refundOperation = {
          outputStates: {
            outputs: [refundForAlice.hash],
            lockedOutputs: [],
          },
          proof: encodeToBytesLocked(encodedProofForRollback),
          data: "0x",
        }
        const tx = await zkPayment.connect(Alice.signer).createLock(
          lockIdAlice,
          lockParameters,
          encodeToBytes(root.bigInt(), encodedProof), // encode the root and proof together
          atomInstance.target,
          settleOperation,
          refundOperation,
          "0x",
        );
        await tx.wait();
      });

      it("Bob fails to fulfill the trade proposal by Alice, so Alice cancels the trade", async function () {
        // Bob does not lock any FHE ERC20 tokens
        // so Alice cancels the trade
        // and the locked UTXO is returned to Alice
        const tx = await atomInstance.connect(Alice.signer).cancel();
        cancelTxResult = await tx.wait();
      });

      it("Alice verifies the trade cancellation by checking the lock events emitted by the Atom contract", async function () {
        // verify the lock events, showing Alice's rollback operation
        // was successfully executed
        const rolledBackEvent = parseLockEvents(atomInstance, cancelTxResult!)[0];
        expect(rolledBackEvent).to.not.be.null;
        expect(rolledBackEvent?.operationIndex).to.equal(0);
        expect(rolledBackEvent?.lockId).to.equal(lockIdAlice);
        expect(rolledBackEvent?.data).to.equal("0x");
      });

      it("Alice verifies the trade cancellation by checking the UTXO events emitted by the Zeto contract", async function () {
        // verify the UTXO events, showing the locked UTXO was returned to Alice
        const events = parseUTXOEvents(zkPayment, cancelTxResult!);
        const rollbackEvent = events[0];
        expect(rollbackEvent).to.not.be.null;
        expect(rollbackEvent?.lockId).to.equal(lockIdAlice);
        expect(rollbackEvent?.rollback.outputStates.outputs[0]).to.equal(refundForAlice.hash);
      });

      it("In the meantime, the other rollback operation has reverted", async function () {
        // the other rollback operation has reverted
        const rollbackFailedEvent = parseLockEvents(atomInstance, cancelTxResult!)[1];
        expect(rollbackFailedEvent).to.not.be.null;
        expect(rollbackFailedEvent?.operationIndex).to.equal(1);
        expect(rollbackFailedEvent?.lockId).to.equal(lockIdBob);
        expect(rollbackFailedEvent?.reason).to.include("0x08c379a0");
        const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + rollbackFailedEvent?.reason.slice(10));
        expect(reason[0]).to.equal("Only the delegate of the lock can refund it");
      });
    });
  });
}).timeout(600000);

function getUTXOHash(value: bigint, salt: bigint, owner: User): bigint {
  return Poseidon.poseidon4([value, salt, owner.babyJubPublicKey[0], owner.babyJubPublicKey[1]]) as bigint;
}

function parseLockEvents(
  lockContract: any,
  result: ContractTransactionReceipt,
) {
  let events: any[] = [];
  for (const log of result.logs || []) {
    const event = lockContract.interface.parseLog(log as any);
    let eventData: any = null;
    if (event?.name === "LockCreated") {
      eventData = {
        lockId: event?.args.lockId,
        owner: event?.args.owner,
        receiver: event?.args.receiver,
        delegate: event?.args.delegate,
        amount: event?.args.amount,
      };
    } else if (event?.name === "LockCreate") {
      eventData = {
        lockId: event?.args.lockId,
        operator: event?.args.operator,
        lockData: event?.args.lockData,
      };
    } else if (event?.name === "AtomDeployed") {
      eventData = {
        atomInstance: event?.args.addr,
      };
    } else if (event?.name === "OperationRolledBack") {
      eventData = {
        operationIndex: event?.args.operationIndex,
        lockId: event?.args.lockId,
        data: event?.args.data,
      };
    } else if (event?.name === "OperationRollbackFailed") {
      eventData = {
        operationIndex: event?.args.operationIndex,
        lockId: event?.args.lockId,
        reason: event?.args.reason,
      };
    }
    if (eventData) {
      events.push(eventData);
    }
  }
  return events;
}