// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract EscrowVault {
    uint256 private constant ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 private constant FIELD_MODULUS = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint8 private constant CORE_ROLE_MASK = 0x03;
    uint8 private constant ALLOWED_BITS_MASK = 0x7F;
    uint8 private constant MIN_SIGNERS = 5;

    error ZeroAddress();
    error ParticipantConflict();
    error DuplicateMediator();
    error InvalidAmount();
    error InvalidDeadline();
    error NotBuyer();
    error NotAuthorized();
    error IncorrectValue();
    error InvalidStatus();
    error InvalidMsgHash();
    error InvalidSignature();
    error InvalidSignerBitmap();
    error InvalidAggregateKey();
    error NotTimedOut();
    error TransferFailed();

    bytes32 public escrowId;
    address public buyer;
    address public seller;
    address[5] public mediators;
    uint256 public pkAggX;
    uint256 public pkAggY;
    uint256 public amount;
    Status public status;
    uint256 public confirmDeadline;
    uint256 public timeoutDeadline;

    enum Status { CREATED, LOCKED, RELEASED, REFUNDED, DISPUTED }

    event EscrowCreated(bytes32 escrowId, address buyer, address seller, uint256 amount);
    event FundsLocked(bytes32 escrowId, uint256 amount);
    event FundsReleased(bytes32 escrowId, address recipient, uint8 signerBitmap, string action);
    event DisputeOpened(bytes32 escrowId);

    constructor(
        bytes32 _escrowId,
        address _buyer,
        address _seller,
        address[5] memory _mediators,
        uint256[2] memory _pkAggCoords,
        uint256 _amount,
        uint256 _confirmDays,
        uint256 _timeoutDays
    ) {
        _validateParticipants(_buyer, _seller, _mediators);
        _validateAggregateKey(_pkAggCoords);
        if (_amount == 0) revert InvalidAmount();
        if (_confirmDays == 0 || _timeoutDays == 0) revert InvalidDeadline();

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

    function release(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint8 signerBitmap) external {
        if (status != Status.LOCKED && status != Status.DISPUTED) revert InvalidStatus();
        _verifyAction("release", rAddr, z, e, msgHash, signerBitmap);

        status = Status.RELEASED;
        _payout(seller);

        emit FundsReleased(escrowId, seller, signerBitmap, "release");
    }

    function refund(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint8 signerBitmap) external {
        if (status != Status.LOCKED && status != Status.DISPUTED) revert InvalidStatus();
        _verifyAction("refund", rAddr, z, e, msgHash, signerBitmap);

        status = Status.REFUNDED;
        _payout(buyer);

        emit FundsReleased(escrowId, buyer, signerBitmap, "refund");
    }

    function dispute() external {
        if (msg.sender != buyer && msg.sender != seller) revert NotAuthorized();
        if (status != Status.LOCKED) revert InvalidStatus();

        status = Status.DISPUTED;
        timeoutDeadline = type(uint256).max;

        emit DisputeOpened(escrowId);
    }

    function timeoutRelease(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint8 signerBitmap) external {
        if (status != Status.LOCKED) revert InvalidStatus();
        if (block.timestamp <= timeoutDeadline) revert NotTimedOut();
        _verifyAction("timeout", rAddr, z, e, msgHash, signerBitmap);

        status = Status.RELEASED;
        _payout(seller);

        emit FundsReleased(escrowId, seller, signerBitmap, "timeout");
    }

    function signerCount(uint8 signerBitmap) public pure returns (uint8) {
        uint8 bitmap = signerBitmap;
        uint8 count;
        while (bitmap != 0) {
            bitmap &= bitmap - 1;
            count++;
        }
        return count;
    }

    function validateSignerBitmap(uint8 signerBitmap) public pure returns (bool) {
        if ((signerBitmap & ~ALLOWED_BITS_MASK) != 0) {
            return false;
        }
        if (signerCount(signerBitmap) < MIN_SIGNERS) {
            return false;
        }
        return (signerBitmap & CORE_ROLE_MASK) != 0;
    }

    function _validateParticipants(address _buyer, address _seller, address[5] memory _mediators) private pure {
    if (_buyer == address(0) || _seller == address(0)) revert ZeroAddress();
    if (_buyer == _seller) revert ParticipantConflict();

    bool allZero = true;
    for (uint8 k = 0; k < 5; k++) {
        if (_mediators[k] != address(0)) { allZero = false; break; }
    }
    if (allZero) return;

    for (uint8 i = 0; i < 5; i++) {
        address mediatorAddr = _mediators[i];
        if (mediatorAddr == address(0)) continue;
        if (mediatorAddr == _buyer || mediatorAddr == _seller) revert ParticipantConflict();

        for (uint8 j = i + 1; j < 5; j++) {
            if (mediatorAddr == _mediators[j]) revert DuplicateMediator();
        }
    }
}

    function _validateAggregateKey(uint256[2] memory coords) private pure {
    if (coords[0] == 0 && coords[1] == 0) return;

    uint256 x = coords[0];
    uint256 y = coords[1];
    if (x == 0 || y == 0 || x >= FIELD_MODULUS || y >= FIELD_MODULUS) {
        revert InvalidAggregateKey();
    }

    uint256 lhs = mulmod(y, y, FIELD_MODULUS);
    uint256 x2 = mulmod(x, x, FIELD_MODULUS);
    uint256 rhs = addmod(mulmod(x2, x, FIELD_MODULUS), 7, FIELD_MODULUS);
    if (lhs != rhs) revert InvalidAggregateKey();
}

    function _payout(address recipient) private {
        (bool success, ) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function _verifyAction(
        string memory action,
        address rAddr,
        bytes32 z,
        bytes32 e,
        bytes32 msgHash,
        uint8 signerBitmap
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