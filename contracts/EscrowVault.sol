// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract EscrowVault {
    uint256 private constant ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    bytes32 public escrowId;
    address public buyer;
    address public seller;
    address public mediator;
    uint256 public pkAggBsX;
    uint256 public pkAggBsY;
    uint256 public pkAggBmX;
    uint256 public pkAggBmY;
    uint256 public pkAggSmX;
    uint256 public pkAggSmY;
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
        uint256[6] memory _pkAggCoords,
        uint256 _amount,
        uint256 _confirmDays,
        uint256 _timeoutDays
    ) {
        escrowId = _escrowId;
        buyer = _buyer;
        seller = _seller;
        mediator = _mediator;
        pkAggBsX = _pkAggCoords[0];
        pkAggBsY = _pkAggCoords[1];
        pkAggBmX = _pkAggCoords[2];
        pkAggBmY = _pkAggCoords[3];
        pkAggSmX = _pkAggCoords[4];
        pkAggSmY = _pkAggCoords[5];
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

    function release(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash) external {
        require(status == Status.LOCKED || status == Status.DISPUTED, "Invalid status");
        
        // Reconstruct expected msg hash
        bytes32 expectedHash = keccak256(abi.encodePacked(escrowId, "release"));
        require(msgHash == expectedHash, "Invalid msgHash");
        
        require(_verifySchnorr(pkAggBsX, pkAggBsY, msgHash, rAddr, z, e), "Invalid signature");

        status = Status.RELEASED;
        payable(seller).transfer(amount);

        emit FundsReleased(escrowId, seller);
    }

    function refund(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash) external {
        require(status == Status.LOCKED || status == Status.DISPUTED, "Invalid status");

        bytes32 expectedHash = keccak256(abi.encodePacked(escrowId, "refund"));
        require(msgHash == expectedHash, "Invalid msgHash");

        require(_verifySchnorr(pkAggBmX, pkAggBmY, msgHash, rAddr, z, e), "Invalid signature");

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

    function timeoutRelease(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash) external {
        require(status == Status.LOCKED, "Invalid status");
        require(block.timestamp > timeoutDeadline, "Not timed out");

        bytes32 expectedHash = keccak256(abi.encodePacked(escrowId, "timeout"));
        require(msgHash == expectedHash, "Invalid msgHash");

        require(_verifySchnorr(pkAggSmX, pkAggSmY, msgHash, rAddr, z, e), "Invalid signature");

        status = Status.RELEASED;
        payable(seller).transfer(amount);

        emit FundsReleased(escrowId, seller);
    }

    function _verifySchnorr(
        uint256 pkX,
        uint256 pkY,
        bytes32 msgHash,
        address rAddr,
        bytes32 z,
        bytes32 e
    ) internal pure returns (bool) {
        if (keccak256(abi.encodePacked(rAddr, pkX, pkY, msgHash)) != e) {
            return false;
        }

        uint256 negZ = addmod(0, ORDER - (uint256(z) % ORDER), ORDER);
        uint256 negE = addmod(0, ORDER - (uint256(e) % ORDER), ORDER);

        address computed = ecrecover(
            bytes32(mulmod(negZ, pkX, ORDER)),
            pkY % 2 == 0 ? 27 : 28,
            bytes32(pkX),
            bytes32(mulmod(negE, pkX, ORDER))
        );
        return computed == rAddr;
    }
}