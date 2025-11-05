// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SampleERC20} from "zeto-solidity/contracts/erc20.sol";
import {SmtLib} from "@iden3/contracts/lib/SmtLib.sol";
import {PoseidonUnit3L} from "@iden3/contracts/lib/Poseidon.sol";
import {Groth16Verifier_Anon} from "zeto-solidity/contracts/verifiers/verifier_anon.sol";
import {Groth16Verifier_AnonBatch} from "zeto-solidity/contracts/verifiers/verifier_anon_batch.sol";
import {Groth16Verifier_AnonNullifierTransfer} from "zeto-solidity/contracts/verifiers/verifier_anon_nullifier_transfer.sol";
import {Groth16Verifier_AnonNullifierTransferBatch} from "zeto-solidity/contracts/verifiers/verifier_anon_nullifier_transfer_batch.sol";
import {Groth16Verifier_AnonNullifierTransferLocked} from "zeto-solidity/contracts/verifiers/verifier_anon_nullifier_transferLocked.sol";
import {Groth16Verifier_AnonNullifierTransferLockedBatch} from "zeto-solidity/contracts/verifiers/verifier_anon_nullifier_transferLocked_batch.sol";
import {Groth16Verifier_Deposit} from "zeto-solidity/contracts/verifiers/verifier_deposit.sol";
import {Groth16Verifier_WithdrawNullifier} from "zeto-solidity/contracts/verifiers/verifier_withdraw_nullifier.sol";
import {Groth16Verifier_WithdrawNullifierBatch} from "zeto-solidity/contracts/verifiers/verifier_withdraw_nullifier_batch.sol";
import {Zeto_AnonNullifier} from "zeto-solidity/contracts/zeto_anon_nullifier.sol";
