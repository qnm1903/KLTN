// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

/**
 * @title MockVRFCoordinator
 * @dev Mock Chainlink VRF v2.5 Coordinator cho test. Chỉ cấp requestId tăng dần;
 *      việc trả số ngẫu nhiên được mô phỏng trực tiếp qua MediatorPool.testFulfillRandomWords.
 */
contract MockVRFCoordinator {
    uint256 private requestIdCounter = 1;
    mapping(uint256 => address) public requesters;

    event RandomWordsRequested(uint256 indexed requestId, address indexed requester);

    /// @dev Khớp selector của IVRFCoordinatorV2Plus.requestRandomWords(RandomWordsRequest).
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata /* req */)
        external
        returns (uint256 requestId)
    {
        requestId = requestIdCounter++;
        requesters[requestId] = msg.sender;
        emit RandomWordsRequested(requestId, msg.sender);
        return requestId;
    }

    /// @dev Tùy chọn: đẩy callback thủ công qua coordinator (test thường dùng
    ///      MediatorPool.testFulfillRandomWords thay cho hàm này).
    function fulfillRandomWords(uint256 requestId, address consumer, uint256[] memory randomWords) external {
        (bool success, ) = consumer.call(
            abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", requestId, randomWords)
        );
        require(success, "Fulfill failed");
    }
}
