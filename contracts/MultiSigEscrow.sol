// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MultiSigEscrow — t-of-n configurable
 * @dev Baseline đối chứng cho EscrowVault (TSS). Mô phỏng đa chữ ký truyền thống:
 *      mỗi người ký gửi MỘT giao dịch on-chain riêng; khi đủ ngưỡng t thì hợp đồng
 *      tự giải ngân. Chi phí xác minh vì thế tăng tuyến tính O(t) theo ngưỡng —
 *      tương phản với verify O(1) của bản TSS.
 *
 *      n = 2 + mediators.length (buyer + seller + mediators). Ngưỡng t cấu hình tự do
 *      để khảo sát chi phí gas theo quy mô hội đồng.
 */
contract MultiSigEscrow {
    bytes32 public escrowId;
    address public buyer;
    address public seller;
    address[] public mediators;
    uint256 public amount;
    Status public status;
    uint256 public confirmDeadline;
    uint256 public timeoutDeadline;
    uint256 public disputeDeadline;

    uint256 public threshold;   // số chữ ký tối thiểu (t)
    uint256 public numParties;  // tổng số bên = 2 + mediators.length

    uint256 private constant DISPUTE_TIMEOUT = 3 days;

    // Theo dõi chữ ký theo từng làn
    mapping(address => bool) public hasSignedRelease;
    mapping(address => bool) public hasSignedRefund;
    mapping(address => bool) public hasSignedTimeout;

    uint256 public releaseSigs;
    uint256 public refundSigs;
    uint256 public timeoutSigs;

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
        address[] memory _mediators,
        uint256 _amount,
        uint256 _confirmDays,
        uint256 _timeoutDays,
        uint256 _threshold
    ) {
        require(_buyer != address(0), "Invalid buyer");
        require(_seller != address(0), "Invalid seller");
        require(_buyer != _seller, "Buyer and seller must differ");

        uint256 _numParties = 2 + _mediators.length;
        require(_threshold > 0 && _threshold <= _numParties, "Invalid threshold");

        escrowId = _escrowId;
        buyer = _buyer;
        seller = _seller;
        mediators = _mediators;
        amount = _amount;
        status = Status.CREATED;
        threshold = _threshold;
        numParties = _numParties;

        confirmDeadline = _confirmDays;
        timeoutDeadline = _timeoutDays;

        emit EscrowCreated(escrowId, buyer, seller, amount);
    }

    modifier onlyParties() {
        bool isParty = msg.sender == buyer || msg.sender == seller;
        if (!isParty) {
            for (uint256 i = 0; i < mediators.length; i++) {
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

        if (releaseSigs >= threshold) {
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

        if (refundSigs >= threshold) {
            _executeRefund();
        }
    }

    function _executeRefund() internal {
        status = Status.REFUNDED;
        _payout(buyer, amount);
        emit FundsReleased(escrowId, buyer);
    }

    function dispute() external {
        require(msg.sender == buyer || msg.sender == seller, "Not authorized");
        require(status == Status.LOCKED, "Invalid status");

        status = Status.DISPUTED;
        timeoutDeadline = type(uint256).max; // chặn quá hạn tự động trong lúc tranh chấp
        disputeDeadline = block.timestamp + DISPUTE_TIMEOUT;

        emit DisputeOpened(escrowId);
    }

    function signTimeout() external onlyParties {
        require(status == Status.LOCKED, "Invalid status");
        require(block.timestamp > timeoutDeadline, "Not timed out");
        require(!hasSignedTimeout[msg.sender], "Already signed");

        hasSignedTimeout[msg.sender] = true;
        timeoutSigs++;

        emit Signed(escrowId, msg.sender, "timeout");

        if (timeoutSigs >= threshold) {
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
