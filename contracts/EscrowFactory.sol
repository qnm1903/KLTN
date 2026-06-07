// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./EscrowVault.sol";

/**
 * @title EscrowFactory — t-of-n configurable
 * @dev Creates EscrowVault instances with configurable threshold and party count.
 *      Default production config: t=5, n=7 (buyer + seller + 5 mediators).
 */
contract EscrowFactory {
    uint256 private constant FIELD_MODULUS = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    error ZeroAddress();
    error ParticipantConflict();
    error DuplicateMediator();
    error InvalidAggregateKey();
    error InvalidThreshold();

    mapping(address => address[]) public escrowsByBuyer;
    mapping(address => address[]) public escrowsBySeller;

    event EscrowCreatedEvent(
        address escrowAddress,
        bytes32 escrowId,
        address buyer,
        address seller,
        address[] mediators,
        uint256 threshold,
        uint256 numParties
    );

    /**
     * @param seller        Địa chỉ người bán
     * @param mediators     Mảng địa chỉ trọng tài (độ dài = n-2, thường là 5 cho config 5-of-7)
     * @param pkAggCoords   Master public key [x, y] từ DKG
     * @param amount        Số wei ký quỹ
     * @param confirmDays   Số ngày để buyer confirm
     * @param timeoutDays   Số ngày trước khi auto-dispute
     * @param threshold     Số chữ ký tối thiểu cần thiết (t), phải > 0 và <= 2 + mediators.length
     */
    function createEscrow(
        address seller,
        address[] calldata mediators,
        uint256[2] calldata pkAggCoords,
        uint256 amount,
        uint256 confirmDays,
        uint256 timeoutDays,
        uint256 threshold
    ) external returns (address) {
        address buyer = msg.sender;
        uint256 numParties = 2 + mediators.length;
        if (threshold == 0 || threshold > numParties) revert InvalidThreshold();

        _validateParticipants(buyer, seller, mediators);
        _validateAggregateKey(pkAggCoords);

        bytes32 escrowId = keccak256(
            abi.encodePacked(
                buyer,
                seller,
                block.timestamp,
                keccak256(abi.encodePacked(mediators)),
                pkAggCoords[0],
                pkAggCoords[1],
                threshold
            )
        );

        address[] memory mediatorsMem = new address[](mediators.length);
        for (uint256 i = 0; i < mediators.length; i++) {
            mediatorsMem[i] = mediators[i];
        }

        EscrowVault vault = new EscrowVault(
            escrowId,
            buyer,
            seller,
            mediatorsMem,
            pkAggCoords,
            amount,
            confirmDays,
            timeoutDays,
            threshold
        );

        address vaultAddress = address(vault);
        escrowsByBuyer[buyer].push(vaultAddress);
        escrowsBySeller[seller].push(vaultAddress);

        emit EscrowCreatedEvent(vaultAddress, escrowId, buyer, seller, mediatorsMem, threshold, numParties);

        return vaultAddress;
    }

    function _validateParticipants(
        address buyer,
        address seller,
        address[] calldata mediators
    ) private pure {
        if (buyer == address(0) || seller == address(0)) revert ZeroAddress();
        if (buyer == seller) revert ParticipantConflict();

        bool allZero = true;
        for (uint256 k = 0; k < mediators.length; k++) {
            if (mediators[k] != address(0)) { allZero = false; break; }
        }
        if (allZero) return;

        for (uint256 i = 0; i < mediators.length; i++) {
            address m = mediators[i];
            if (m == address(0)) continue;
            if (m == buyer || m == seller) revert ParticipantConflict();
            for (uint256 j = i + 1; j < mediators.length; j++) {
                if (m == mediators[j]) revert DuplicateMediator();
            }
        }
    }

    function _validateAggregateKey(uint256[2] calldata coords) private pure {
        if (coords[0] == 0 && coords[1] == 0) return;
        uint256 x = coords[0];
        uint256 y = coords[1];
        if (x == 0 || y == 0 || x >= FIELD_MODULUS || y >= FIELD_MODULUS) revert InvalidAggregateKey();
        uint256 lhs = mulmod(y, y, FIELD_MODULUS);
        uint256 x2 = mulmod(x, x, FIELD_MODULUS);
        uint256 rhs = addmod(mulmod(x2, x, FIELD_MODULUS), 7, FIELD_MODULUS);
        if (lhs != rhs) revert InvalidAggregateKey();
    }
}
