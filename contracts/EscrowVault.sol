// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract EscrowVault {
    using ECDSA for bytes32;

    bytes32 public escrowId;
    address public buyer;
    address public seller;
    address public mediator;
    address public pkAggAddress;
    uint256 public amount;
    Status public status;
    uint256 public confirmDeadline;
    uint256 public timeoutDeadline;

    enum Status { CREATED, LOCKED, RELEASED, REFUNDED, DISPUTED }

    event EscrowCreated(bytes32 escrowId, address buyer, address seller, uint256 amount);
    event FundsLocked(bytes32 escrowId, uint256 amount);
    event FundsReleased(bytes32 escrowId, address recipient);
    event DisputeOpened(bytes32 escrowId);

    constructor(
        bytes32 _escrowId,
        address _buyer,
        address _seller,
        address _mediator,
        address _pkAggAddress,
        uint256 _amount,
        uint256 _confirmDays,
        uint256 _timeoutDays
    ) {
        escrowId = _escrowId;
        buyer = _buyer;
        seller = _seller;
        mediator = _mediator;
        pkAggAddress = _pkAggAddress;
        amount = _amount;
        status = Status.CREATED;
        
        confirmDeadline = _confirmDays;
        timeoutDeadline = _timeoutDays;
        
        emit EscrowCreated(escrowId, buyer, seller, amount);
    }

    function lockFunds() external payable {
        require(msg.sender == buyer, "Only buyer can lock");
        require(msg.value == amount, "Incorrect value");
        require(status == Status.CREATED, "Invalid status");

        status = Status.LOCKED;
        confirmDeadline = block.timestamp + confirmDeadline * 1 days;
        timeoutDeadline = block.timestamp + timeoutDeadline * 1 days;

        emit FundsLocked(escrowId, amount);
    }

    function release(bytes32 r, bytes32 s, uint8 v, bytes32 msgHash) external {
        require(status == Status.LOCKED || status == Status.DISPUTED, "Invalid status");
        
        // Reconstruct expected msg hash
        bytes32 expectedHash = keccak256(abi.encodePacked(escrowId, "release"));
        require(msgHash == expectedHash, "Invalid msgHash");
        
        // Verify signature
        require(_verifySignature(r, s, v, msgHash), "Invalid signature");

        status = Status.RELEASED;
        payable(seller).transfer(amount);

        emit FundsReleased(escrowId, seller);
    }

    function refund(bytes32 r, bytes32 s, uint8 v, bytes32 msgHash) external {
        require(status == Status.LOCKED || status == Status.DISPUTED, "Invalid status");

        bytes32 expectedHash = keccak256(abi.encodePacked(escrowId, "refund"));
        require(msgHash == expectedHash, "Invalid msgHash");

        require(_verifySignature(r, s, v, msgHash), "Invalid signature");

        status = Status.REFUNDED;
        payable(buyer).transfer(amount);

        emit FundsReleased(escrowId, buyer);
    }

    function dispute() external {
        require(msg.sender == buyer, "Only buyer");
        require(status == Status.LOCKED, "Invalid status");

        status = Status.DISPUTED;
        timeoutDeadline = type(uint256).max; // Reset timeout to prevent automatic timeout release during dispute

        emit DisputeOpened(escrowId);
    }

    function timeoutRelease(bytes32 r, bytes32 s, uint8 v, bytes32 msgHash) external {
        require(status == Status.LOCKED, "Invalid status");
        require(block.timestamp > timeoutDeadline, "Not timed out");

        bytes32 expectedHash = keccak256(abi.encodePacked(escrowId, "timeout"));
        require(msgHash == expectedHash, "Invalid msgHash");

        require(_verifySignature(r, s, v, msgHash), "Invalid signature");

        status = Status.RELEASED;
        payable(seller).transfer(amount);

        emit FundsReleased(escrowId, seller);
    }

    function _verifySignature(bytes32 r, bytes32 s, uint8 v, bytes32 msgHash) internal view returns (bool) {
        address recovered = ecrecover(msgHash, v, r, s);
        return recovered == pkAggAddress;
    }
}