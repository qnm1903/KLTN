// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract MultiSigEscrow {
    using ECDSA for bytes32;

    bytes32 public escrowId;
    address public buyer;
    address public seller;
    address[5] public mediators;
    uint256 public amount;
    Status public status;
    uint256 public confirmDeadline;
    uint256 public timeoutDeadline;

    // Threshold: 5 out of 7 signers (buyer + seller + 5 mediators)
    uint8 private constant THRESHOLD_SIGNERS = 5;
    uint8 private constant TOTAL_SIGNERS = 7;

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
        address[5] memory _mediators,
        uint256 _amount,
        uint256 _confirmDays,
        uint256 _timeoutDays
    ) {
        require(_buyer != address(0), "Invalid buyer");
        require(_seller != address(0), "Invalid seller");
        require(_buyer != _seller, "Buyer and seller must differ");

        escrowId = _escrowId;
        buyer = _buyer;
        seller = _seller;
        mediators = _mediators;
        amount = _amount;
        status = Status.CREATED;
        
        confirmDeadline = _confirmDays;
        timeoutDeadline = _timeoutDays;
        
        emit EscrowCreated(escrowId, buyer, seller, amount);
    }

    modifier onlyParties() {
        bool isParty = msg.sender == buyer || msg.sender == seller;
        if (!isParty) {
            for (uint8 i = 0; i < 5; i++) {
                if (msg.sender == mediators[i]) {
                    isParty = true;
                    break;
                }
            }
        }
        require(isParty, "Not a party");
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

        if (releaseSigs >= THRESHOLD_SIGNERS) {
            _executeRelease();
        }
    }

    function _executeRelease() internal {
        status = Status.RELEASED;
        _payout(seller, amount);
        emit FundsReleased(escrowId, seller);
    }

    function signRefund() external onlyParties {
        require(status == Status.LOCKED || status == Status.DISPUTED, "Invalid status");
        require(!hasSignedRefund[msg.sender], "Already signed");

        hasSignedRefund[msg.sender] = true;
        refundSigs++;

        emit Signed(escrowId, msg.sender, "refund");

        if (refundSigs >= THRESHOLD_SIGNERS) {
            _executeRefund();
        }
    }

    function _executeRefund() internal {
        status = Status.REFUNDED;
        _payout(buyer, amount);
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

        hasSignedTimeout[msg.sender] = true;
        timeoutSigs++;

        emit Signed(escrowId, msg.sender, "timeout");

        if (timeoutSigs >= THRESHOLD_SIGNERS) {
            _executeTimeout();
        }
    }

    function _executeTimeout() internal {
        status = Status.RELEASED;
        _payout(seller, amount);
        emit FundsReleased(escrowId, seller);
    }

    // ─── Safe payout using low-level call ─────────────────────────────────

    function _payout(address recipient, uint256 value) private {
        (bool success, ) = payable(recipient).call{value: value}("");
        require(success, "Transfer failed");
    }
}