// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title EcdsaEscrow — đối chứng ECDSA-TSS với logic escrow đầy đủ
 * @dev Mô phỏng kịch bản ECDSA threshold (GG20) trên EVM: các bên tổng hợp off-chain thành
 *      MỘT chữ ký ECDSA gốc, hợp đồng xác minh bằng ecrecover. Logic escrow (mediators,
 *      bitmap, ngưỡng, deadline, dispute) giữ TƯƠNG ĐƯƠNG EscrowVault để phép đo gas
 *      so sánh công bằng — chênh lệch chỉ đến từ nguyên thủy xác minh.
 */
contract EcdsaEscrow {
    uint256 private constant CORE_ROLE_MASK = 0x03;

    error InvalidStatus();
    error IncorrectValue();
    error NotBuyer();
    error NotAuthorized();
    error InvalidSignature();
    error InvalidSignerBitmap();
    error InvalidThreshold();
    error TransferFailed();

    bytes32 public escrowId;
    address public buyer;
    address public seller;
    address[] public mediators;
    uint256 public amount;
    Status public status;
    uint256 public confirmDeadline;
    uint256 public timeoutDeadline;
    uint256 public disputeDeadline;

    uint256 public threshold;
    uint256 public numParties;

    address public groupSigner;

    uint256 private constant DISPUTE_TIMEOUT = 3 days;

    enum Status { CREATED, LOCKED, RELEASED, REFUNDED, DISPUTED }

    event EscrowCreated(bytes32 escrowId, address buyer, address seller, uint256 amount);
    event FundsLocked(bytes32 escrowId, uint256 amount);
    event FundsReleased(bytes32 escrowId, address recipient, uint256 signerBitmap, string action);
    event DisputeOpened(bytes32 escrowId);

    constructor(
        bytes32 _escrowId,
        address _buyer,
        address _seller,
        address[] memory _mediators,
        uint256 _amount,
        uint256 _confirmDays,
        uint256 _timeoutDays,
        uint256 _threshold,
        address _groupSigner
    ) {
        escrowId = _escrowId;
        buyer = _buyer;
        seller = _seller;
        mediators = _mediators;
        amount = _amount;
        status = Status.CREATED;
        confirmDeadline = _confirmDays;
        timeoutDeadline = _timeoutDays;
        uint256 _numParties = 2 + _mediators.length;
        if (_threshold == 0 || _threshold > _numParties) revert InvalidThreshold();
        threshold = _threshold;
        numParties = _numParties;
        groupSigner = _groupSigner;
        emit EscrowCreated(escrowId, buyer, seller, amount);
    }

    function lockFunds() external payable {
        if (msg.sender != buyer) revert NotBuyer();
        if (msg.value != amount) revert IncorrectValue();
        if (status != Status.CREATED) revert InvalidStatus();
        status = Status.LOCKED;
        confirmDeadline = block.timestamp + confirmDeadline * 1 days;
        timeoutDeadline = block.timestamp + timeoutDeadline * 1 days;
        emit FundsLocked(escrowId, amount);
    }

    function release(uint8 v, bytes32 r, bytes32 s, uint256 signerBitmap) external {
        if (status != Status.LOCKED && status != Status.DISPUTED) revert InvalidStatus();
        _verifyEcdsa("release", v, r, s, signerBitmap);
        status = Status.RELEASED;
        _payout(seller, amount);
        emit FundsReleased(escrowId, seller, signerBitmap, "release");
    }

    function refund(uint8 v, bytes32 r, bytes32 s, uint256 signerBitmap) external {
        if (status != Status.LOCKED && status != Status.DISPUTED) revert InvalidStatus();
        _verifyEcdsa("refund", v, r, s, signerBitmap);
        status = Status.REFUNDED;
        _payout(buyer, amount);
        emit FundsReleased(escrowId, buyer, signerBitmap, "refund");
    }

    function dispute() external {
        if (msg.sender != buyer && msg.sender != seller) revert NotAuthorized();
        if (status != Status.LOCKED) revert InvalidStatus();
        status = Status.DISPUTED;
        timeoutDeadline = type(uint256).max;
        disputeDeadline = block.timestamp + DISPUTE_TIMEOUT;
        emit DisputeOpened(escrowId);
    }

    // ─── Bitmap (giống EscrowVault) ─────────────────────────────────────────────

    function signerCount(uint256 bitmap) public pure returns (uint256) {
        uint256 b = bitmap;
        uint256 count;
        while (b != 0) { b &= b - 1; count++; }
        return count;
    }

    function validateSignerBitmap(uint256 bitmap) public view returns (bool) {
        uint256 allowedMask = (1 << numParties) - 1;
        if ((bitmap & ~allowedMask) != 0) return false;
        if (signerCount(bitmap) < threshold) return false;
        return (bitmap & CORE_ROLE_MASK) != 0;
    }

    // ─── Verify ─────────────────────────────────────────────────────────────────

    function _verifyEcdsa(
        string memory action, uint8 v, bytes32 r, bytes32 s, uint256 signerBitmap
    ) private view {
        if (!validateSignerBitmap(signerBitmap)) revert InvalidSignerBitmap();
        bytes32 msgHash = keccak256(
            abi.encodePacked(block.chainid, address(this), escrowId, action, signerBitmap)
        );
        address recovered = ecrecover(msgHash, v, r, s);
        if (recovered == address(0) || recovered != groupSigner) revert InvalidSignature();
    }

    function _payout(address recipient, uint256 value) private {
        (bool success, ) = payable(recipient).call{value: value}("");
        if (!success) revert TransferFailed();
    }
}
