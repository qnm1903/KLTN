// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./EscrowVault.sol";

contract EscrowFactory {
    mapping(address => address[]) public escrowsByBuyer;
    mapping(address => address[]) public escrowsBySeller;

    event EscrowCreatedEvent(address escrowAddress, bytes32 escrowId, address buyer, address seller);

    function createEscrow(
        address seller,
        address mediator,
        uint256[6] calldata pkAggCoords,
        uint256 amount,
        uint256 confirmDays,
        uint256 timeoutDays
    ) external returns (address) {
        address buyer = msg.sender;
        // Generate pseudo-random escrowId based on inputs and timestamp
        bytes32 escrowId = keccak256(
            abi.encodePacked(
                buyer,
                seller,
                block.timestamp,
                pkAggCoords[0],
                pkAggCoords[1],
                pkAggCoords[2],
                pkAggCoords[3],
                pkAggCoords[4],
                pkAggCoords[5]
            )
        );

        EscrowVault vault = new EscrowVault(
            escrowId,
            buyer,
            seller,
            mediator,
            pkAggCoords,
            amount,
            confirmDays,
            timeoutDays
        );

        address vaultAddress = address(vault);
        
        escrowsByBuyer[buyer].push(vaultAddress);
        escrowsBySeller[seller].push(vaultAddress);

        emit EscrowCreatedEvent(vaultAddress, escrowId, buyer, seller);

        return vaultAddress;
    }
}