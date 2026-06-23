// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title BatchedMultiSigEscrow — đối chứng đa chữ ký kiểu Gnosis Safe
 * @dev Mô hình đa chữ ký phổ biến nhất trên Ethereum hiện nay (Gnosis Safe): các chủ sở
 *      hữu ký off-chain (EIP-712), một bên chuyển tiếp gửi DUY NHẤT một giao dịch chứa
 *      t chữ ký nối tiếp; hợp đồng xác minh trong vòng lặp `ecrecover`. Nhờ gộp, chỉ tốn
 *      MỘT phí cơ sở 21k thay vì t lần — nhưng chi phí xác minh vẫn O(t) (t lần ecrecover
 *      + đọc calldata t×65 byte), tương phản verify O(1) của bản TSS.
 *
 *      Chữ ký phải sắp xếp theo địa chỉ tăng dần để bảo đảm duy nhất (giống checkNSignatures
 *      của Gnosis Safe). n = 2 + mediators.length; ngưỡng t cấu hình tự do.
 */
contract BatchedMultiSigEscrow {
    bytes32 public escrowId;
    address public buyer;
    address public seller;
    uint256 public amount;
    uint256 public threshold;
    uint256 public numParties;
    Status  public status;

    mapping(address => bool) public isOwner;

    enum Status { CREATED, LOCKED, RELEASED, REFUNDED, DISPUTED }

    event FundsLocked(bytes32 escrowId, uint256 amount);
    event FundsReleased(bytes32 escrowId, address recipient);
    event DisputeOpened(bytes32 escrowId);

    error InvalidStatus();
    error IncorrectValue();
    error NotBuyer();
    error InvalidThreshold();
    error BadSignatureCount();
    error InvalidSignature();
    error NotOwner();
    error UnorderedSignatures();
    error TransferFailed();

    constructor(
        bytes32 _escrowId,
        address _buyer,
        address _seller,
        address[] memory _mediators,
        uint256 _amount,
        uint256 _threshold
    ) {
        require(_buyer != address(0) && _seller != address(0) && _buyer != _seller, "bad parties");
        uint256 _numParties = 2 + _mediators.length;
        if (_threshold == 0 || _threshold > _numParties) revert InvalidThreshold();

        escrowId = _escrowId;
        buyer = _buyer;
        seller = _seller;
        amount = _amount;
        threshold = _threshold;
        numParties = _numParties;
        status = Status.CREATED;

        isOwner[_buyer] = true;
        isOwner[_seller] = true;
        for (uint256 i = 0; i < _mediators.length; i++) {
            isOwner[_mediators[i]] = true;
        }
    }

    function lockFunds() external payable {
        if (msg.sender != buyer) revert NotBuyer();
        if (msg.value != amount) revert IncorrectValue();
        if (status != Status.CREATED) revert InvalidStatus();
        status = Status.LOCKED;
        emit FundsLocked(escrowId, amount);
    }

    function dispute() external {
        if (msg.sender != buyer) revert NotBuyer();
        if (status != Status.LOCKED) revert InvalidStatus();
        status = Status.DISPUTED;
        emit DisputeOpened(escrowId);
    }

    function release(bytes calldata signatures) external {
        if (status != Status.LOCKED && status != Status.DISPUTED) revert InvalidStatus();
        _checkSignatures("release", signatures);
        status = Status.RELEASED;
        _payout(seller, amount);
        emit FundsReleased(escrowId, seller);
    }

    function refund(bytes calldata signatures) external {
        if (status != Status.LOCKED && status != Status.DISPUTED) revert InvalidStatus();
        _checkSignatures("refund", signatures);
        status = Status.REFUNDED;
        _payout(buyer, amount);
        emit FundsReleased(escrowId, buyer);
    }

    /// @dev Lặp ecrecover t chữ ký 65-byte nối tiếp; địa chỉ phải tăng dần (duy nhất).
    function _checkSignatures(string memory action, bytes calldata signatures) private view {
        if (signatures.length != threshold * 65) revert BadSignatureCount();
        bytes32 digest = keccak256(abi.encodePacked(block.chainid, address(this), escrowId, action));

        address last = address(0);
        for (uint256 i = 0; i < threshold; i++) {
            uint256 off = i * 65;
            bytes32 r = bytes32(signatures[off:off + 32]);
            bytes32 s = bytes32(signatures[off + 32:off + 64]);
            uint8   v = uint8(signatures[off + 64]);

            address recovered = ecrecover(digest, v, r, s);
            if (recovered == address(0)) revert InvalidSignature();
            if (recovered <= last) revert UnorderedSignatures();
            if (!isOwner[recovered]) revert NotOwner();
            last = recovered;
        }
    }

    function _payout(address recipient, uint256 value) private {
        (bool success, ) = payable(recipient).call{value: value}("");
        if (!success) revert TransferFailed();
    }
}
