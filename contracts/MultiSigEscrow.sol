// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract MultiSigEscrow {
    using ECDSA for bytes32;

    bytes32 public escrowId;
    address public buyer;
    address public seller;
    address public mediator;
    uint256 public amount;
    Status public status;
    uint256 public confirmDeadline;
    uint256 public timeoutDeadline;

    // Tracking signatures
    mapping(address => bool) public hasSignedRelease;
    mapping(address => bool) public hasSignedRefund;
    mapping(address => bool) public hasSignedTimeout;

    uint8 public releaseSigs;
    uint8 public refundSigs;
    uint8 public timeoutSigs;

    enum Status { CREATED, LOCKED, RELEASED, REFUNDED, DISPUTED }

    event EscrowCreated(bytes32 escrowId, address buyer, address seller, uint256 amount);
    event FundsLocked(bytes32 escrowId, uint256 amount);
    event FundsReleased(bytes32 escrowId, address recipient);
    event DisputeOpened(bytes32 escrowId);
    event Signed(bytes32 escrowId, address signer, string action);

    constructor(
        bytes32 _escrowId,
        address _buyer,
        address _seller,
        address _mediator,
        uint256 _amount,
        uint256 _confirmDays,
        uint256 _timeoutDays
    ) {
        escrowId = _escrowId;
        buyer = _buyer;
        seller = _seller;
        mediator = _mediator;
        amount = _amount;
        status = Status.CREATED;
        
        confirmDeadline = _confirmDays;
        timeoutDeadline = _timeoutDays;
        
        emit EscrowCreated(escrowId, buyer, seller, amount);
    }

    modifier onlyParties() {
        require(msg.sender == buyer || msg.sender == seller || msg.sender == mediator, "Not a party");
        _;
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

    function signRelease() external onlyParties {
        require(status == Status.LOCKED || status == Status.DISPUTED, "Invalid status");
        require(!hasSignedRelease[msg.sender], "Already signed");

        hasSignedRelease[msg.sender] = true;
        releaseSigs++;
        
        emit Signed(escrowId, msg.sender, "release");

        if (releaseSigs >= 2) {
            _executeRelease();
        }
    }

    function _executeRelease() internal {
        status = Status.RELEASED;
        payable(seller).transfer(amount);
        emit FundsReleased(escrowId, seller);
    }

    function signRefund() external onlyParties {
        require(status == Status.LOCKED || status == Status.DISPUTED, "Invalid status");
        require(!hasSignedRefund[msg.sender], "Already signed");

        hasSignedRefund[msg.sender] = true;
        refundSigs++;

        emit Signed(escrowId, msg.sender, "refund");

        if (refundSigs >= 2) {
            _executeRefund();
        }
    }

    function _executeRefund() internal {
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

    function signTimeout() external onlyParties {
        require(status == Status.LOCKED, "Invalid status");
        require(block.timestamp > timeoutDeadline, "Not timed out");
        require(!hasSignedTimeout[msg.sender], "Already signed");
        require(msg.sender != buyer, "Buyer cannot timeout sign"); // Usually seller and mediator do this

        hasSignedTimeout[msg.sender] = true;
        timeoutSigs++;

        emit Signed(escrowId, msg.sender, "timeout");

        if (timeoutSigs >= 2) {
            _executeTimeout();
        }
    }

    function _executeTimeout() internal {
        status = Status.RELEASED;
        payable(seller).transfer(amount);
        emit FundsReleased(escrowId, seller);
    }
}