// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockVRFCoordinator
 * @dev Mock Chainlink VRF Coordinator for testing
 */
contract MockVRFCoordinator {
    uint256 private requestIdCounter = 1;
    mapping(uint256 => address) public requesters;
    
    event RandomWordsRequested(
        uint256 indexed requestId,
        address indexed requester,
        bytes32 keyHash,
        uint256 subId,
        uint16 minimumRequestConfirmations,
        uint32 callbackGasLimit,
        uint32 numWords
    );
    
    function requestRandomWords(
        bytes32 keyHash,
        uint64 subId,
        uint16 minimumRequestConfirmations,
        uint32 callbackGasLimit,
        uint32 numWords
    ) external returns (uint256 requestId) {
        requestId = requestIdCounter++;
        requesters[requestId] = msg.sender;
        
        emit RandomWordsRequested(
            requestId,
            msg.sender,
            keyHash,
            subId,
            minimumRequestConfirmations,
            callbackGasLimit,
            numWords
        );
        
        return requestId;
    }
    
    // Mock fulfill function to be called in tests
    // Calls rawFulfillRandomWords which is public in VRFConsumerBaseV2
    function fulfillRandomWords(
        uint256 requestId,
        address consumer,
        uint256[] memory randomWords
    ) external {
        // In real scenario, this is called by Chainlink
        // For testing, we allow anyone to call
        (bool success, ) = consumer.call(
            abi.encodeWithSignature(
                "rawFulfillRandomWords(uint256,uint256[])",
                requestId,
                randomWords
            )
        );
        require(success, "Fulfill failed");
    }
}