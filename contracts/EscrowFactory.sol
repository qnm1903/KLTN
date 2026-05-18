// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./EscrowVault.sol";

contract EscrowFactory {
    uint256 private constant FIELD_MODULUS = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    error ZeroAddress();
    error ParticipantConflict();
    error DuplicateMediator();
    error InvalidAggregateKey();

    mapping(address => address[]) public escrowsByBuyer;
    mapping(address => address[]) public escrowsBySeller;

    event EscrowCreatedEvent(
        address escrowAddress,
        bytes32 escrowId,
        address buyer,
        address seller,
        address[5] mediators
    );

    function createEscrow(
        address seller,
        address[5] calldata mediators,
        uint256[2] calldata pkAggCoords,
        uint256 amount,
        uint256 confirmDays,
        uint256 timeoutDays
    ) external returns (address) {
        address buyer = msg.sender;
        _validateParticipants(buyer, seller, mediators);
        _validateAggregateKey(pkAggCoords);

        bytes32 escrowId = keccak256(
            abi.encodePacked(
                buyer,
                seller,
                block.timestamp,
                mediators[0],
                mediators[1],
                mediators[2],
                mediators[3],
                mediators[4],
                pkAggCoords[0],
                pkAggCoords[1]
            )
        );

        EscrowVault vault = new EscrowVault(
            escrowId, 
            buyer, seller, mediators,
            pkAggCoords,
            amount, confirmDays, timeoutDays
        );

        address vaultAddress = address(vault);
        escrowsByBuyer[buyer].push(vaultAddress);
        escrowsBySeller[seller].push(vaultAddress);

        emit EscrowCreatedEvent(vaultAddress, escrowId, buyer, seller, mediators);

        return vaultAddress;
    }

    function _validateParticipants(
    address buyer,
    address seller,
    address[5] calldata mediators
    ) private pure {
    if (buyer == address(0) || seller == address(0)) revert ZeroAddress();
    if (buyer == seller) revert ParticipantConflict();

    // Cho phép trường hợp đặc biệt: 5 Trọng tài đều là ví rỗng (Kiến trúc VRF)
    bool allZero = true;
    for (uint8 k = 0; k < 5; k++) {
        if (mediators[k] != address(0)) { allZero = false; break; }
    }
    if (allZero) return;

    // Nếu có truyền Trọng tài thật, thì mới tiến hành kiểm tra trùng lặp
    for (uint8 i = 0; i < 5; i++) {
        address mediatorAddr = mediators[i];
        if (mediatorAddr == address(0)) continue; 
        if (mediatorAddr == buyer || mediatorAddr == seller) revert ParticipantConflict();

        for (uint8 j = i + 1; j < 5; j++) {
            if (mediatorAddr == mediators[j]) revert DuplicateMediator();
        }
    }
    }

    function _validateAggregateKey(uint256[2] calldata coords) private pure {
    // Cho phép tọa độ (0,0) - Tức là Khóa TSS chưa được tạo
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
}