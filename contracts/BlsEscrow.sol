// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title BlsEscrow — đối chứng xác minh chữ ký ngưỡng BLS (BLS12-381) on-chain
 * @dev Dùng để đo chi phí gas thật của verify BLS trên EVM qua precompile EIP-2537
 *      (có từ bản nâng cấp Pectra, 2025). Chữ ký ngưỡng BLS được tổng hợp off-chain
 *      thành một chữ ký σ ∈ G1 và một khóa công khai gộp pk ∈ G2; hợp đồng chỉ xác
 *      minh O(1) bằng một phép kiểm tra cặp ghép (pairing).
 *
 *      Phương trình: e(σ, -G2) · e(H(m), pk) == 1.
 *      H(m): ánh xạ thông điệp tới G1 bằng MAP_FP_TO_G1 (đơn ánh, đủ cho ràng buộc
 *      thông điệp trong phép đo; không phải hash_to_curve hai-map đầy đủ RFC 9380).
 *
 *      Mục đích DUY NHẤT là benchmark verify BLS; không dùng cho sản xuất.
 */
contract BlsEscrow {
    address private constant MAP_FP_TO_G1 = 0x0000000000000000000000000000000000000010;
    address private constant PAIRING_CHECK = 0x000000000000000000000000000000000000000F;

    bytes32 public escrowId;
    address public buyer;
    address public seller;
    uint256 public amount;
    Status public status;

    // Khóa công khai gộp pk ∈ G2 (256 byte theo mã hóa EIP-2537), đặt khi khởi tạo.
    bytes public pk;

    enum Status { CREATED, LOCKED, RELEASED, REFUNDED, DISPUTED }

    event FundsLocked(bytes32 escrowId, uint256 amount);
    event FundsReleased(bytes32 escrowId, address recipient);

    error InvalidStatus();
    error InvalidPk();
    error IncorrectValue();
    error InvalidSignature();
    error PrecompileFailed();
    error TransferFailed();

    constructor(bytes32 _escrowId, address _buyer, address _seller, uint256 _amount, bytes memory _pk) {
        if (_pk.length != 256) revert InvalidPk();
        escrowId = _escrowId;
        buyer = _buyer;
        seller = _seller;
        amount = _amount;
        pk = _pk;
        status = Status.CREATED;
    }

    function lockFunds() external payable {
        if (msg.sender != buyer) revert InvalidStatus();
        if (msg.value != amount) revert IncorrectValue();
        if (status != Status.CREATED) revert InvalidStatus();
        status = Status.LOCKED;
        emit FundsLocked(escrowId, amount);
    }

    /// @param sig Chữ ký ngưỡng BLS đã tổng hợp σ ∈ G1 (128 byte, mã hóa EIP-2537).
    function release(bytes calldata sig) external {
        if (status != Status.LOCKED && status != Status.DISPUTED) revert InvalidStatus();
        if (sig.length != 128) revert InvalidSignature();

        bytes32 msgHash = keccak256(abi.encodePacked(block.chainid, address(this), escrowId, "release"));
        if (!_verifyBls(msgHash, sig)) revert InvalidSignature();

        status = Status.RELEASED;
        _payout(seller, amount);
        emit FundsReleased(escrowId, seller);
    }

    function _verifyBls(bytes32 msgHash, bytes calldata sig) private view returns (bool) {
        // H(m): map field element (32 byte zero pad ++ msgHash = 64 byte Fp) → G1 (128 byte)
        (bool okMap, bytes memory hm) = MAP_FP_TO_G1.staticcall(abi.encodePacked(bytes32(0), msgHash));
        if (!okMap || hm.length != 128) revert PrecompileFailed();

        // pairing input: σ(128) ++ (-G2)(256) ++ H(m)(128) ++ pk(256) = 768 byte
        bytes memory input = abi.encodePacked(sig, _negG2(), hm, pk);
        (bool okPair, bytes memory out) = PAIRING_CHECK.staticcall(input);
        if (!okPair || out.length != 32) revert PrecompileFailed();
        return abi.decode(out, (uint256)) == 1;
    }

    /// @dev Hằng số -G2 (phủ định phần tử sinh G2), mã hóa EIP-2537 (Fp2 theo thứ tự c0,c1).
    function _negG2() private pure returns (bytes memory) {
        return abi.encodePacked(
            bytes32(0x00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051),
            bytes32(0xc6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8),
            bytes32(0x0000000000000000000000000000000013e02b6052719f607dacd3a088274f65),
            bytes32(0x596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e),
            bytes32(0x000000000000000000000000000000000d1b3cc2c7027888be51d9ef691d77bc),
            bytes32(0xb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa),
            bytes32(0x0000000000000000000000000000000013fa4d4a0ad8b1ce186ed5061789213d),
            bytes32(0x993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed)
        );
    }

    function _payout(address recipient, uint256 value) private {
        (bool success, ) = payable(recipient).call{value: value}("");
        if (!success) revert TransferFailed();
    }
}
