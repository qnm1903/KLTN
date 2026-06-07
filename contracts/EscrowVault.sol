// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title EscrowVault — t-of-n configurable
 * @dev Supports any threshold t and party count n (buyer + seller + mediators).
 *      signerBitmap uses uint256 to support n > 8.
 *      Bit layout: bit 0 = buyer, bit 1 = seller, bit 2..n-1 = mediator1..mediator(n-2)
 */
contract EscrowVault {
    uint256 private constant ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 private constant FIELD_MODULUS = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 private constant CORE_ROLE_MASK = 0x03; // bit0=buyer, bit1=seller

    error ZeroAddress();
    error ParticipantConflict();
    error DuplicateMediator();
    error InvalidAmount();
    error InvalidDeadline();
    error InvalidThreshold();
    error NotBuyer();
    error NotAuthorized();
    error IncorrectValue();
    error InvalidStatus();
    error InvalidMsgHash();
    error InvalidSignature();
    error InvalidSignerBitmap();
    error InvalidAggregateKey();
    error InvalidSplitAmount();
    error NotTimedOut();
    error DisputeNotTimedOut();
    error TransferFailed();

    bytes32 public escrowId;
    address public buyer;
    address public seller;
    address[] public mediators;
    uint256 public pkAggX;
    uint256 public pkAggY;
    uint256 public amount;
    Status public status;
    uint256 public confirmDeadline;
    uint256 public timeoutDeadline;
    uint256 public disputeDeadline;

    // t-of-n config (set at construction, immutable after)
    uint256 public threshold;   // minimum signers required
    uint256 public numParties;  // total parties = 2 + mediators.length

    uint256 private constant DISPUTE_TIMEOUT = 3 days;

    enum Status { CREATED, LOCKED, RELEASED, REFUNDED, DISPUTED }

    event EscrowCreated(bytes32 escrowId, address buyer, address seller, uint256 amount);
    event FundsLocked(bytes32 escrowId, uint256 amount);
    event FundsReleased(bytes32 escrowId, address recipient, uint256 signerBitmap, string action);
    event FundsSplit(bytes32 escrowId, address buyer, address seller, uint256 buyerAmount, uint256 sellerAmount, uint256 signerBitmap);
    event DisputeOpened(bytes32 escrowId);

    constructor(
        bytes32 _escrowId,
        address _buyer,
        address _seller,
        address[] memory _mediators,
        uint256[2] memory _pkAggCoords,
        uint256 _amount,
        uint256 _confirmDays,
        uint256 _timeoutDays,
        uint256 _threshold
    ) {
        _validateParticipants(_buyer, _seller, _mediators);
        _validateAggregateKey(_pkAggCoords);
        if (_amount == 0) revert InvalidAmount();
        if (_confirmDays == 0 || _timeoutDays == 0) revert InvalidDeadline();
        uint256 _numParties = 2 + _mediators.length;
        if (_threshold == 0 || _threshold > _numParties) revert InvalidThreshold();

        escrowId = _escrowId;
        buyer = _buyer;
        seller = _seller;
        mediators = _mediators;
        pkAggX = _pkAggCoords[0];
        pkAggY = _pkAggCoords[1];
        amount = _amount;
        status = Status.CREATED;
        confirmDeadline = _confirmDays;
        timeoutDeadline = _timeoutDays;
        threshold = _threshold;
        numParties = _numParties;

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

    function release(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint256 signerBitmap) external {
        if (status != Status.LOCKED && status != Status.DISPUTED) revert InvalidStatus();
        _verifyAction("release", rAddr, z, e, msgHash, signerBitmap);
        status = Status.RELEASED;
        _payout(seller, amount);
        emit FundsReleased(escrowId, seller, signerBitmap, "release");
    }

    function refund(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint256 signerBitmap) external {
        if (status != Status.LOCKED && status != Status.DISPUTED) revert InvalidStatus();
        _verifyAction("refund", rAddr, z, e, msgHash, signerBitmap);
        status = Status.REFUNDED;
        _payout(buyer, amount);
        emit FundsReleased(escrowId, buyer, signerBitmap, "refund");
    }

    function split(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint256 signerBitmap) external {
        if (status != Status.LOCKED && status != Status.DISPUTED) revert InvalidStatus();
        _verifyAction("split", rAddr, z, e, msgHash, signerBitmap);

        uint256 buyerAmount = amount / 2;
        uint256 sellerAmount = amount - buyerAmount;

        status = Status.RELEASED;
        _payout(buyer, buyerAmount);
        _payout(seller, sellerAmount);

        emit FundsSplit(escrowId, buyer, seller, buyerAmount, sellerAmount, signerBitmap);
    }

    function dispute() external {
        if (msg.sender != buyer && msg.sender != seller) revert NotAuthorized();
        if (status != Status.LOCKED) revert InvalidStatus();

        status = Status.DISPUTED;
        timeoutDeadline = type(uint256).max;
        disputeDeadline = block.timestamp + DISPUTE_TIMEOUT;

        emit DisputeOpened(escrowId);
    }

    /**
     * @dev Khi dispute không được giải quyết sau DISPUTE_TIMEOUT, ai cũng có thể trigger split 50/50.
     */
    function timeoutSplit() external {
        if (status != Status.DISPUTED) revert InvalidStatus();
        if (block.timestamp <= disputeDeadline) revert DisputeNotTimedOut();

        uint256 buyerAmount = amount / 2;
        uint256 sellerAmount = amount - buyerAmount;

        status = Status.RELEASED;
        _payout(buyer, buyerAmount);
        _payout(seller, sellerAmount);

        emit FundsSplit(escrowId, buyer, seller, buyerAmount, sellerAmount, 0);
    }

    function timeoutRelease(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint256 signerBitmap) external {
        if (status != Status.LOCKED) revert InvalidStatus();
        if (block.timestamp <= timeoutDeadline) revert NotTimedOut();
        _verifyAction("timeout", rAddr, z, e, msgHash, signerBitmap);
        status = Status.RELEASED;
        _payout(seller, amount);
        emit FundsReleased(escrowId, seller, signerBitmap, "timeout");
    }

    // ─── Bitmap helpers ────────────────────────────────────────────────────────

    function signerCount(uint256 bitmap) public pure returns (uint256) {
        uint256 b = bitmap;
        uint256 count;
        while (b != 0) { b &= b - 1; count++; }
        return count;
    }

    function validateSignerBitmap(uint256 bitmap) public view returns (bool) {
        // Only bits 0..numParties-1 allowed
        uint256 allowedMask = (1 << numParties) - 1;
        if ((bitmap & ~allowedMask) != 0) return false;
        if (signerCount(bitmap) < threshold) return false;
        return (bitmap & CORE_ROLE_MASK) != 0;
    }

    // ─── Internal helpers ──────────────────────────────────────────────────────

    function _validateParticipants(address _buyer, address _seller, address[] memory _mediators) private pure {
        if (_buyer == address(0) || _seller == address(0)) revert ZeroAddress();
        if (_buyer == _seller) revert ParticipantConflict();

        bool allZero = true;
        for (uint256 k = 0; k < _mediators.length; k++) {
            if (_mediators[k] != address(0)) { allZero = false; break; }
        }
        if (allZero) return;

        for (uint256 i = 0; i < _mediators.length; i++) {
            address m = _mediators[i];
            if (m == address(0)) continue;
            if (m == _buyer || m == _seller) revert ParticipantConflict();
            for (uint256 j = i + 1; j < _mediators.length; j++) {
                if (m == _mediators[j]) revert DuplicateMediator();
            }
        }
    }

    function _validateAggregateKey(uint256[2] memory coords) private pure {
        if (coords[0] == 0 && coords[1] == 0) return;
        uint256 x = coords[0];
        uint256 y = coords[1];
        if (x == 0 || y == 0 || x >= FIELD_MODULUS || y >= FIELD_MODULUS) revert InvalidAggregateKey();
        uint256 lhs = mulmod(y, y, FIELD_MODULUS);
        uint256 x2 = mulmod(x, x, FIELD_MODULUS);
        uint256 rhs = addmod(mulmod(x2, x, FIELD_MODULUS), 7, FIELD_MODULUS);
        if (lhs != rhs) revert InvalidAggregateKey();
    }

    function _payout(address recipient, uint256 payoutAmount) private {
        (bool success, ) = payable(recipient).call{value: payoutAmount}("");
        if (!success) revert TransferFailed();
    }

    function _verifyAction(
        string memory action,
        address rAddr,
        bytes32 z,
        bytes32 e,
        bytes32 msgHash,
        uint256 signerBitmap
    ) private view {
        if (!validateSignerBitmap(signerBitmap)) revert InvalidSignerBitmap();

        bytes32 expectedHash = keccak256(
            abi.encodePacked(block.chainid, address(this), escrowId, action, signerBitmap)
        );
        if (msgHash != expectedHash) revert InvalidMsgHash();
        if (!_verifySchnorr(pkAggX, pkAggY, msgHash, rAddr, z, e)) revert InvalidSignature();
    }

    function _verifySchnorr(
        uint256 pkX,
        uint256 pkY,
        bytes32 msgHash,
        address rAddr,
        bytes32 z,
        bytes32 e
    ) internal pure returns (bool) {
        if (keccak256(abi.encodePacked(rAddr, pkX, pkY, msgHash)) != e) return false;

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
