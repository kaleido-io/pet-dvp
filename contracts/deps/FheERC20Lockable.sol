// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {FheERC20} from "./FheERC20.sol";
import {ILockableConfidentialERC20} from "../interfaces/ILockableConfidentialERC20.sol";
import {console} from "hardhat/console.sol";

contract FheERC20Lockable is FheERC20, ILockableConfidentialERC20 {
    mapping(bytes32 => Lock) private _locks;
    mapping(address => euint64) private _lockedBalances;

    function createLock(
        bytes32 lockId,
        address receiver,
        address delegate,
        externalEuint64 amount,
        bytes calldata proof,
        bytes calldata data
    ) public {
        euint64 encryptedAmount = FHE.fromExternal(amount, proof);

        euint64 ptr;

        euint64 transferred = confidentialTransfer(
            address(this),
            encryptedAmount
        );
        _locks[lockId] = Lock(msg.sender, receiver, transferred, delegate);

        ptr = FHE.add(_lockedBalances[msg.sender], transferred);
        FHE.allowThis(ptr);
        FHE.allow(ptr, delegate);
        FHE.allow(transferred, delegate);
        FHE.allow(transferred, receiver);
        emit LockCreated(
            lockId,
            msg.sender,
            receiver,
            delegate,
            transferred,
            data
        );
    }

    function settleLock(bytes32 lockId, bytes calldata data) public {
        Lock memory lock = _locks[lockId];
        require(
            lock.delegate == msg.sender,
            "Only the delegate of the lock can settle it"
        );

        euint64 transferred = _transferFromAsTrustedOperator(
            address(this),
            lock.receiver, // for settle, the receiver is the recipient of the locked tokens
            lock.amount
        );
        euint64 ptr;

        ptr = FHE.sub(_lockedBalances[lock.owner], transferred);
        FHE.allowThis(ptr);
        FHE.allow(ptr, lock.owner);
        _lockedBalances[lock.owner] = ptr;

        emit LockSettled(
            lockId,
            lock.owner,
            lock.receiver,
            lock.delegate,
            transferred,
            data
        );
    }

    function refundLock(bytes32 lockId, bytes calldata data) public {
        Lock memory lock = _locks[lockId];
        require(
            lock.delegate == msg.sender,
            "Only the delegate of the lock can refund it"
        );
        euint64 transferred = _transfer(
            address(this),
            lock.owner, // for refund, the owner is the recipient of the locked tokens
            lock.amount
        );

        euint64 ptr;

        ptr = FHE.add(_lockedBalances[lock.owner], transferred);
        FHE.allowThis(ptr);
        FHE.allow(ptr, lock.owner);
        _lockedBalances[lock.owner] = ptr;

        emit LockRefunded(
            lockId,
            lock.owner,
            lock.receiver,
            lock.delegate,
            transferred,
            data
        );
    }

    function _transferFromAsTrustedOperator(
        address from,
        address to,
        euint64 amount
    ) internal returns (euint64 transferred) {
        require(
            FHE.isAllowed(amount, msg.sender),
            ERC7984UnauthorizedUseOfEncryptedAmount(amount, msg.sender)
        );
        // do not require isOperator(from, msg.sender), because this was called by the delegate as trusted operator
        transferred = _transfer(from, to, amount);
        FHE.allowTransient(transferred, msg.sender);
    }
}
