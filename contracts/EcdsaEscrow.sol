// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title EcdsaEscrow — đối chứng xác minh chữ ký ngưỡng ECDSA on-chain
 * @dev Trong ECDSA threshold (GG18/GG20), các bên tổng hợp off-chain thành MỘT chữ ký
 *      ECDSA hợp lệ ứng với một khóa công khai nhóm duy nhất. Trên chuỗi, việc xác minh
 *      vì thế chỉ là một lần `ecrecover` — y hệt chi phí một chữ ký đơn (O(1)).
 *      Hợp đồng này đo đúng chi phí on-chain đó. Toàn bộ chi phí đặc thù của ECDSA-TSS
 *      (Paillier, MtA, ZK) nằm ở off-chain và được đo riêng.
 */
contract EcdsaEscrow {
    bytes32 public escrowId;
    address public buyer;
    address public seller;
    uint256 public amount;
    Status public status;

    // Địa chỉ ứng với khóa công khai nhóm (kết quả DKG ECDSA-TSS), đặt khi khởi tạo.
    address public groupSigner;

    enum Status { CREATED, LOCKED, RELEASED, REFUNDED, DISPUTED }

    event FundsLocked(bytes32 escrowId, uint256 amount);
    event FundsReleased(bytes32 escrowId, address recipient);

    error InvalidStatus();
    error IncorrectValue();
    error InvalidSignature();
    error TransferFailed();

    constructor(bytes32 _escrowId, address _buyer, address _seller, uint256 _amount, address _groupSigner) {
        escrowId = _escrowId;
        buyer = _buyer;
        seller = _seller;
        amount = _amount;
        groupSigner = _groupSigner;
        status = Status.CREATED;
    }

    function lockFunds() external payable {
        if (msg.sender != buyer) revert InvalidStatus();
        if (msg.value != amount) revert IncorrectValue();
        if (status != Status.CREATED) revert InvalidStatus();
        status = Status.LOCKED;
        emit FundsLocked(escrowId, amount);
    }

    function release(uint8 v, bytes32 r, bytes32 s) external {
        if (status != Status.LOCKED && status != Status.DISPUTED) revert InvalidStatus();

        bytes32 msgHash = keccak256(abi.encodePacked(block.chainid, address(this), escrowId, "release"));
        address recovered = ecrecover(msgHash, v, r, s);
        if (recovered == address(0) || recovered != groupSigner) revert InvalidSignature();

        status = Status.RELEASED;
        _payout(seller, amount);
        emit FundsReleased(escrowId, seller);
    }

    function _payout(address recipient, uint256 value) private {
        (bool success, ) = payable(recipient).call{value: value}("");
        if (!success) revert TransferFailed();
    }
}
