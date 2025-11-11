// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ILockable} from "./ILockable.sol";

interface ILockableConfidentialERC20 is ILockable {
    event LockCreated(
        bytes32 lockId,
        address owner,
        address receiver,
        address delegate,
        euint64 amount,
        bytes data
    );
    event LockSettled(
        bytes32 lockId,
        address owner,
        address receiver,
        address delegate,
        euint64 amount,
        bytes data
    );
    event LockRolledBack(
        bytes32 lockId,
        address owner,
        address receiver,
        address delegate,
        euint64 amount,
        bytes data
    );

    struct Lock {
        address owner;
        address receiver;
        euint64 amount;
        address delegate;
    }
}
